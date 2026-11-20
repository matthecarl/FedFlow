type RealtimeEvent = { type: string; [key: string]: any }
type ResponseRequest = { event: RealtimeEvent; label: string }

/** One owner for default-conversation inference, including VAD and tool continuations. */
export class RealtimeResponseCoordinator {
    private active: { id: string | null; eventId?: string; supersededByVoice?: boolean } | null = null
    private pending: ResponseRequest | null = null
    private cancelRequested = false
    private cancelSent = false
    private inputPending = false
    private toolCalls = new Set<string>()

    constructor(
        private send: (event: RealtimeEvent, label: string) => void,
        private createEventId: () => string,
        private canRespond = () => true,
    ) {}

    request(event: RealtimeEvent, label = "") {
        // A single continuation can answer all committed input/tool outputs.
        // Keep the full request so specialist-introduction instructions survive.
        this.pending = { event: { ...event, event_id: event.event_id || this.createEventId() }, label }
        this.flush()
    }

    interrupt() {
        this.pending = null
        if (this.active) {
            this.cancelRequested = true
            this.cancelWhenIdentified()
        }
    }

    beginInput(interruptPlayback = true) {
        this.inputPending = true
        if (interruptPlayback) this.interrupt()
        else if (this.active) this.active.supersededByVoice = true
    }

    discardInput() {
        // A deliberate input-mode change clears audio without a commit event.
        this.inputPending = false
    }

    receive(event: RealtimeEvent) {
        if (event.type === "response.created") {
            this.active = { ...this.active, id: event.response.id }
            this.cancelWhenIdentified()
        } else if (event.type === "response.done") {
            // An old completion must never unlock a newer/in-flight request.
            if (!this.active?.id || event.response.id !== this.active.id) return
            const supersededByVoice = this.active.supersededByVoice
            this.active = null
            this.cancelRequested = false
            this.cancelSent = false
            if (event.response.status === "completed") {
                for (const item of event.response.output || []) {
                    if (item.type === "function_call" && item.call_id && item.name && item.arguments) this.toolCalls.add(item.call_id)
                }
            }
            return supersededByVoice
        } else if (event.type === "input_audio_buffer.committed") {
            this.inputPending = false
            // Both server VAD and push-to-talk wait for the committed input.
            this.request({ type: "response.create" }, "respond to committed voice input")
        } else if (event.type === "error") {
            // Rejected creates have no response.done. Release only that request;
            // unrelated tool/session errors must not unlock an active response.
            if (event.error?.event_id && event.error.event_id === this.active?.eventId &&
                event.error.code !== "conversation_already_has_active_response") {
                this.active = null
                this.cancelRequested = false
                this.cancelSent = false
            }
            if (event.error?.code === "input_audio_buffer_commit_empty") this.inputPending = false
        }
    }

    toolOutputSent(callId: string) {
        this.toolCalls.delete(callId)
        // The batch sends its one continuation after every output is written.
    }

    flush() {
        if (!this.pending || this.active || this.inputPending || this.toolCalls.size || !this.canRespond()) return
        const request = this.pending
        this.pending = null
        this.active = { id: null, eventId: request.event.event_id }
        try {
            this.send(request.event, request.label)
        } catch (error) {
            this.active = null
            throw error
        }
    }

    reset() {
        this.active = null
        this.pending = null
        this.cancelRequested = false
        this.cancelSent = false
        this.inputPending = false
        this.toolCalls.clear()
    }

    private cancelWhenIdentified() {
        if (!this.cancelRequested || this.cancelSent || !this.active?.id) return
        this.cancelSent = true
        this.send({ type: "response.cancel", response_id: this.active.id }, "cancel due to user interruption")
        // Only the matching response.done releases the next response.
    }
}
