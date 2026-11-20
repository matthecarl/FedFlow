import {
    Experimental_AbstractRealtimeSession,
    experimental_decodeRealtimeAudio,
    gateway,
    type Experimental_RealtimeClientEvent,
    type Experimental_RealtimeServerEvent,
    type Experimental_RealtimeSessionOptions,
    type Experimental_RealtimeUsage,
} from "ai"

type WireEvent = { type: string; [key: string]: any }
type FunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string }
type AssistantMessage = { type: "message"; role: "assistant"; id: string; content: [{ type: "output_audio"; transcript: string }] }
type InputAudio = Extract<Experimental_RealtimeClientEvent, { type: "input-audio-append" }>

// About 70 seconds of 24 kHz mono PCM in base64. Allow smaller frames when
// the SDK resamples a higher capture rate. Only one replay write is in flight.
const MAX_HELD_AUDIO_FRAMES = 3_200
const MAX_HELD_AUDIO_BYTES = 4_500_000
const AUDIO_REPLAY_INTERVAL_MS = 16
const RESPONSE_START_TIMEOUT_MS = 30_000
const SPEECH_FRAME_SECONDS = 0.01
const CONSECUTIVE_SPEECH_FRAMES = 3
const SPEECH_RMS = 0.006

function normalizeUsage(usage?: Experimental_RealtimeUsage) {
    if (!usage) return undefined
    return {
        total_tokens: usage.inputTokens == null && usage.outputTokens == null
            ? undefined : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        input_token_details: {
            text_tokens: usage.inputTextTokens,
            audio_tokens: usage.inputAudioTokens,
            cached_tokens: usage.cachedInputTokens,
        },
        output_token_details: { text_tokens: usage.outputTextTokens, audio_tokens: usage.outputAudioTokens },
    }
}

class GatewaySession extends Experimental_AbstractRealtimeSession {
    constructor(
        options: Experimental_RealtimeSessionOptions,
        private onStatus: (status: string) => void,
        private onPlaybackChange?: (isPlaying: boolean) => void,
    ) {
        super(options)
    }

    get isAudioPlaying() {
        return this.state.isPlaying
    }

    protected setState(key: string, value: unknown) {
        if (key === "status" && typeof value === "string") this.onStatus(value)
        if (key === "isPlaying" && typeof value === "boolean") this.onPlaybackChange?.(value)
    }
}

interface GatewayTransportOptions {
    agent: string
    model: string
    config: Experimental_RealtimeSessionOptions["sessionConfig"]
    playbackEnabled: boolean
    onEvent: (event: WireEvent) => void
    onPlaybackChange?: (isPlaying: boolean) => void
    onBufferedSpeech?: () => void
    onOpen: () => void
    onClose: () => void
    onError: () => void
}

/** Translate the Gateway events consumed by FedFlow's shared transcript and tool dispatcher. */
export class GatewayRealtimeTransport {
    readyState: RTCDataChannelState = "connecting"
    private session: GatewaySession
    private playbackEnabled: boolean
    private activeResponse: string | null = null
    private interruptedResponses = new Set<string>()
    private completedResponses = new Set<string>()
    private responses = new Map<string, {
        calls: Map<string, FunctionCall>
        messages: Map<string, AssistantMessage>
    }>()
    private toolNames = new Map<string, string>()
    private stream: MediaStream | null = null
    private heldAudio: InputAudio[] = []
    private heldAudioBytes = 0
    private replayingAudio: InputAudio | null = null
    private responseStartDeadline = 0
    private responseStarting: { eventId?: string; timer: ReturnType<typeof setTimeout> } | null = null
    private speechSamples = 0
    private speechEnergy = 0
    private voicedFrames = 0
    private notifiedBufferedSpeech = false
    private speechFrameSamples: number

    constructor(private options: GatewayTransportOptions) {
        this.playbackEnabled = options.playbackEnabled
        this.speechFrameSamples = Math.ceil((options.config?.inputAudioFormat?.rate ?? 24_000) * SPEECH_FRAME_SECONDS)
        const gatewayModel = gateway.experimental_realtime(options.model)
        this.session = new GatewaySession({
            model: {
                specificationVersion: gatewayModel.specificationVersion,
                modelId: gatewayModel.modelId,
                provider: gatewayModel.provider,
                capabilities: gatewayModel.capabilities,
                getWebSocketConfig: gatewayModel.getWebSocketConfig?.bind(gatewayModel),
                serializeClientEvent: (event, options) => {
                    if (event.type === "input-audio-append" && !this.shouldSendAudio(event)) return null
                    return gatewayModel.serializeClientEvent(event, options)
                },
                buildSessionConfig: gatewayModel.buildSessionConfig.bind(gatewayModel),
                parseServerEvent: (raw) => {
                    const event = gatewayModel.parseServerEvent(raw)
                    return (Array.isArray(event) ? event : [event]).filter(
                        (part) => part.type !== "audio-delta" ||
                            (this.playbackEnabled && !this.interruptedResponses.has(part.responseId)),
                    )
                },
            },
            api: { token: `/api/session/gateway?agent=${encodeURIComponent(options.agent)}` },
            sessionConfig: options.config,
            maxEvents: 20,
            // The shared dispatcher batches tool results and owns the follow-up response.
            onToolCall: () => undefined,
            onEvent: (event) => this.receive(event),
        }, (status) => {
            if (this.readyState === "closed") return
            if (status === "connected" && this.readyState === "connecting") {
                this.readyState = "open"
                options.onOpen()
            } else if (status === "error") {
                this.fail()
            } else if (status === "disconnected") {
                this.clearResponseStart()
                this.clearHeldAudio()
                options.onClose()
            }
        }, (isPlaying) => {
            if (this.readyState !== "open") return
            options.onPlaybackChange?.(isPlaying)
            if (!isPlaying) void this.replayAudio()
        })
    }

    get isAudioPlaying() {
        return this.session.isAudioPlaying
    }

    private get shouldHoldAudio() {
        return this.isAudioPlaying || Date.now() < this.responseStartDeadline ||
            (this.activeResponse !== null && !this.interruptedResponses.has(this.activeResponse))
    }

    private shouldSendAudio(event: InputAudio) {
        if (this.readyState !== "open") return false
        if (event === this.replayingAudio) {
            // Generation may resume while this frame is waiting in the SDK codec queue.
            if (this.shouldHoldAudio || this.heldAudio[0] !== event) return false
            this.heldAudio.shift()
            this.heldAudioBytes -= event.audio.length
            return true
        }
        if (!this.shouldHoldAudio && !this.heldAudio.length && !this.replayingAudio) return true

        // Keep the most recent continuous input when a long reply fills the buffer.
        // Gateway audio is base64, so its character count is its encoded byte count.
        if (event.audio.length <= MAX_HELD_AUDIO_BYTES) {
            while (this.heldAudio.length >= MAX_HELD_AUDIO_FRAMES || this.heldAudioBytes + event.audio.length > MAX_HELD_AUDIO_BYTES) {
                this.heldAudioBytes -= this.heldAudio.shift()!.audio.length
            }
            this.heldAudio.push(event)
            this.heldAudioBytes += event.audio.length
            this.observeBufferedSpeech(event.audio)
        }
        void this.replayAudio()
        return false
    }

    private async replayAudio() {
        if (this.replayingAudio) return
        try {
            while (this.readyState === "open" && !this.shouldHoldAudio && this.heldAudio.length) {
                const frame = this.heldAudio[0]
                this.replayingAudio = frame
                await this.session.sendEvent(frame)
                if (this.heldAudio[0] === frame) break
                // Let the browser drain its WebSocket send buffer between frames.
                if (this.heldAudio.length) await new Promise((resolve) => setTimeout(resolve, AUDIO_REPLAY_INTERVAL_MS))
            }
        } catch {
            this.fail()
        } finally {
            this.replayingAudio = null
            if (this.heldAudio.length === 0) this.resetSpeechDetector()
        }
    }

    private observeBufferedSpeech(audio: string) {
        if (!this.options.onBufferedSpeech || this.notifiedBufferedSpeech) return
        let samples: Float32Array
        try {
            samples = experimental_decodeRealtimeAudio(audio)
        } catch {
            this.resetSpeechDetector()
            return
        }
        for (const sample of samples) {
            this.speechEnergy += sample * sample
            if (++this.speechSamples < this.speechFrameSamples) continue
            const voiced = this.speechEnergy >= this.speechSamples * SPEECH_RMS * SPEECH_RMS
            this.voicedFrames = voiced ? this.voicedFrames + 1 : 0
            this.speechEnergy = 0
            this.speechSamples = 0
            if (this.voicedFrames >= CONSECUTIVE_SPEECH_FRAMES) {
                this.notifiedBufferedSpeech = true
                this.options.onBufferedSpeech()
                return
            }
        }
    }

    private resetSpeechDetector() {
        this.speechSamples = 0
        this.speechEnergy = 0
        this.voicedFrames = 0
        this.notifiedBufferedSpeech = false
    }

    private clearHeldAudio() {
        this.heldAudio = []
        this.heldAudioBytes = 0
        this.responseStartDeadline = 0
        this.resetSpeechDetector()
    }

    private clearResponseStart() {
        if (this.responseStarting) clearTimeout(this.responseStarting.timer)
        this.responseStarting = null
        this.responseStartDeadline = 0
    }

    private fail() {
        this.clearResponseStart()
        this.clearHeldAudio()
        if (this.readyState !== "closed") this.options.onError()
    }

    async connect(stream: MediaStream) {
        this.stream = stream
        await this.session.connect({ stream, capture: false })
    }

    startCapture() {
        if (this.readyState !== "open" || !this.stream) return
        try {
            this.session.startAudioCapture(this.stream)
        } catch {
            this.options.onError()
        }
    }

    send(event: WireEvent) {
        let command: Experimental_RealtimeClientEvent
        switch (event.type) {
            case "conversation.item.create": {
                const item = event.item
                if (item?.type === "function_call_output") {
                    if (!item.call_id || !this.toolNames.has(item.call_id)) return
                    command = {
                        type: "conversation-item-create",
                        item: { type: "function-call-output", callId: item.call_id, name: this.toolNames.get(item.call_id), output: item.output },
                    }
                    this.toolNames.delete(item.call_id)
                } else {
                    const text = item?.content?.find((part: { type: string }) => part.type === "input_text")?.text
                    if (item?.type !== "message" || item.role !== "user" || typeof text !== "string") return
                    command = { type: "conversation-item-create", item: { type: "text-message", role: "user", text } }
                }
                break
            }
            case "response.create":
                this.clearResponseStart()
                this.responseStartDeadline = Date.now() + RESPONSE_START_TIMEOUT_MS
                this.responseStarting = {
                    eventId: event.event_id,
                    timer: setTimeout(() => this.fail(), RESPONSE_START_TIMEOUT_MS),
                }
                command = {
                    type: "response-create",
                    options: event.response?.instructions ? { instructions: event.response.instructions } : undefined,
                }
                break
            case "response.cancel":
                this.clearHeldAudio()
                command = { type: "response-cancel" }
                break
            default:
                return
        }
        try {
            void this.session.sendEvent(command).catch(() => this.fail())
        } catch {
            this.fail()
        }
    }

    async setPlaybackEnabled(enabled: boolean) {
        this.playbackEnabled = enabled
        if (enabled) await this.session.resumePlayback()
        else this.session.stopPlayback()
    }

    stopPlayback() {
        this.clearHeldAudio()
        this.stopAssistantOutput()
    }

    private stopAssistantOutput() {
        if (this.activeResponse) this.interruptedResponses.add(this.activeResponse)
        this.session.stopPlayback()
    }

    close() {
        this.readyState = "closed"
        this.clearResponseStart()
        this.clearHeldAudio()
        this.session.dispose()
        this.stream = null
        this.responses.clear()
        this.interruptedResponses.clear()
        this.completedResponses.clear()
        this.toolNames.clear()
    }

    private getResponse(id: string) {
        let response = this.responses.get(id)
        if (!response) {
            response = { calls: new Map(), messages: new Map() }
            this.responses.set(id, response)
        }
        return response
    }

    private receive(event: Experimental_RealtimeServerEvent) {
        if (this.readyState === "closed") return
        const emit = this.options.onEvent
        // Gemini can start output without a response-created event. Its first
        // response-scoped event still has the ID that completes the turn.
        if ("responseId" in event && event.responseId && event.type !== "delegation-created") {
            if (this.completedResponses.has(event.responseId)) return
            if (!this.responses.has(event.responseId)) {
                this.clearResponseStart()
                this.getResponse(event.responseId)
                this.activeResponse = event.responseId
                emit({ type: "response.created", response: { id: event.responseId } })
            }
        }
        switch (event.type) {
            case "session-created":
                emit({ type: "session.created", session: { id: event.sessionId } })
                break
            case "speech-started":
                // Speech detection can acknowledge the leading frames of a replay.
                this.stopAssistantOutput()
                emit({ type: "input_audio_buffer.speech_started" })
                break
            case "input-transcription-completed":
                emit({ type: "conversation.item.added", item: { id: event.itemId, type: "message", role: "user" } })
                emit({ type: "conversation.item.input_audio_transcription.completed", item_id: event.itemId, transcript: event.transcript })
                break
            case "function-call-arguments-done":
                this.toolNames.set(event.callId, event.name)
                this.getResponse(event.responseId).calls.set(event.callId, {
                    type: "function_call", call_id: event.callId, name: event.name, arguments: event.arguments,
                })
                break
            case "audio-transcript-delta":
            case "audio-transcript-done":
            case "text-delta":
            case "text-done": {
                const { itemId, responseId } = event
                const { messages } = this.getResponse(responseId)
                let message = messages.get(itemId)
                if (!message) {
                    message = { id: itemId, type: "message", role: "assistant", content: [{ type: "output_audio", transcript: "" }] }
                    messages.set(itemId, message)
                    emit({ type: "conversation.item.added", item: { id: itemId, type: "message", role: "assistant" } })
                }
                if ("delta" in event) {
                    message.content[0].transcript += event.delta
                    emit({ type: "response.output_audio_transcript.delta", item_id: itemId, delta: event.delta })
                } else {
                    const transcript = event.type === "text-done" ? event.text : event.transcript
                    message.content[0].transcript = transcript ?? message.content[0].transcript
                    emit({ type: "response.output_item.done", item: message })
                }
                break
            }
            case "response-done": {
                const response = this.responses.get(event.responseId)
                this.responses.delete(event.responseId)
                this.completedResponses.add(event.responseId)
                if (this.completedResponses.size > 32) {
                    this.completedResponses.delete(this.completedResponses.values().next().value!)
                }
                this.interruptedResponses.delete(event.responseId)
                if (this.activeResponse === event.responseId) this.activeResponse = null
                const status = event.status === "complete" ? "completed" : event.status
                for (const message of response?.messages.values() ?? []) emit({ type: "response.output_item.done", item: message })
                emit({
                    type: "response.done",
                    response: {
                        id: event.responseId, status, model: this.options.model, usage: normalizeUsage(event.usage),
                        output: [...response?.messages.values() ?? [], ...response?.calls.values() ?? []],
                    },
                })
                for (const id of response?.calls.keys() ?? []) if (status !== "completed") this.toolNames.delete(id)
                void this.replayAudio()
                break
            }
            case "error": {
                // Normalized response-create has no eventId field. An error
                // during startup without correlation cannot safely be retried.
                const startsResponse = this.responseStarting !== null
                const hasClientEventId = !!event.clientEventId
                const matchesCreate = hasClientEventId && event.clientEventId === this.responseStarting?.eventId
                const overlap = event.code === "conversation_already_has_active_response"
                const reconnect = this.readyState === "connecting" || (startsResponse && (!hasClientEventId || (matchesCreate && overlap)))
                if (matchesCreate) this.clearResponseStart()
                emit({
                    type: "error",
                    error: { code: event.code, event_id: event.clientEventId, message: "The voice provider returned an error." },
                })
                if (reconnect) this.fail()
                else void this.replayAudio()
                break
            }
        }
    }
}
