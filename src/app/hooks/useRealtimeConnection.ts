import { useRef, useState, useEffect } from "react"
import { v4 as uuidv4 } from "uuid"
import { SessionStatus, UseRealtimeConnectionProps } from "@/app/types"
import { createRealtimeConnection, RealtimeConnectionStage } from "@/app/lib/realtimeConnection"
import { parseSseFrame, safeParseSseData, splitSseFrames } from "@/app/lib/agent-builder-sse"
import { useTranscript } from "@/app/contexts/TranscriptContext"
import { useEvent } from "@/app/contexts/EventContext"
import { useHandleServerEvent } from "./useHandleServerEvent"
import { useAgentBuilderMirror } from "./useAgentBuilderMirror"
import { recordServerEvent } from "../lib/client-telemetry"
import { RealtimeResponseCoordinator } from "@/app/lib/realtimeResponseCoordinator"

export function useRealtimeConnection({
    selectedAgentName,
    setSelectedAgentName,
    selectedAgentConfigSet,
    conversationMode,
}: UseRealtimeConnectionProps) {
    const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED")
    const [connectionError, setConnectionError] = useState<string | null>(null)
    const [microphoneRequired, setMicrophoneRequired] = useState(false)
    const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false)
    const connectionAbortRef = useRef<AbortController | null>(null)
    const initializedAgentRef = useRef<string | null>(null)
    const handoffConfiguredAgentRef = useRef<string | null>(null)
    const configuredPTTRef = useRef<boolean | null>(null)
    const autoConnectAttemptedRef = useRef(false)
    const deliberatelyDisconnectedRef = useRef(false)
    const responseCoordinatorRef = useRef<RealtimeResponseCoordinator | null>(null)
    const audioPlayingRef = useRef(false)
    const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null)
    const [localStream, setLocalStream] = useState<MediaStream | null>(null)
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
    const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false)
    const [isPTTActive, setIsPTTActive] = useState<boolean>(false) // Default value
    const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true) // Default value

    // Load settings from localStorage only after component has mounted on client
    useEffect(() => {
        // This only runs on the client after mount
        const storedPTT = localStorage.getItem("pushToTalkUI")
        if (storedPTT !== null) {
            setIsPTTActive(storedPTT === "true")
        }

        const storedAudio = localStorage.getItem("audioPlaybackEnabled")
        if (storedAudio !== null) {
            setIsAudioPlaybackEnabled(storedAudio === "true")
        }
    }, []) // Empty dependency array ensures this only runs once after mount
    const [userText, setUserText] = useState<string>("")
    const [isAgentBuilderSending, setIsAgentBuilderSending] = useState<boolean>(false)

    // References
    const pcRef = useRef<RTCPeerConnection | null>(null)
    const dcRef = useRef<RTCDataChannel | null>(null)
    const audioElementRef = useRef<HTMLAudioElement | null>(null)
    const updateSessionCounterRef = useRef(0)
    const dcEventHandlersRef = useRef<{
        open: () => void
        close: () => void
        error: (err: any) => void
        message: (e: MessageEvent) => void
    } | null>(null)
    const agentBuilderConversationIdRef = useRef<string | null>(null)
    const agentBuilderConversationIdsByAgentRef = useRef<Record<string, string>>({})

    const { addTranscriptMessage, addTranscriptBreadcrumb, updateTranscriptMessage, updateTranscriptItemStatus } =
        useTranscript()
    const { logClientEvent, logServerEvent } = useEvent()
    const { mirrorTurn } = useAgentBuilderMirror()
    const isRealtimeVoiceMode = conversationMode === "realtime_voice_mirror"
    if (!responseCoordinatorRef.current) {
        responseCoordinatorRef.current = new RealtimeResponseCoordinator(sendWireEvent, uuidv4)
    }

    // Prevent cross-agent context leakage in Agent Builder text mode by keying conversation IDs per selected agent.
    useEffect(() => {
        const key = selectedAgentName?.trim()
        if (!key) {
            agentBuilderConversationIdRef.current = null
            return
        }

        agentBuilderConversationIdRef.current = agentBuilderConversationIdsByAgentRef.current[key] ?? null
    }, [selectedAgentName])
    const extractConversationIdFromSsePayload = (payload: unknown): string | null => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return null
        }

        const payloadObj = payload as Record<string, unknown>
        const directId =
            (typeof payloadObj.conversation_id === "string" && payloadObj.conversation_id) ||
            (typeof payloadObj.conversationId === "string" && payloadObj.conversationId)
        if (directId) {
            return directId
        }

        const nested = payloadObj.data
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
            return null
        }

        const nestedObj = nested as Record<string, unknown>
        return (
            (typeof nestedObj.conversation_id === "string" && nestedObj.conversation_id) ||
            (typeof nestedObj.conversationId === "string" && nestedObj.conversationId) ||
            null
        )
    }

    const extractMessageTextFromSsePayload = (payload: unknown): string | null => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return null
        }

        const payloadObj = payload as Record<string, unknown>
        const extractFrom = (value: unknown): string | null => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return null
            }
            const obj = value as Record<string, unknown>
            if (typeof obj.message === "string") {
                return obj.message
            }
            if (typeof obj.chunk === "string") {
                return obj.chunk
            }
            // Kibana Agent Builder SSE uses `text_chunk` for deltas.
            if (typeof obj.text_chunk === "string") {
                return obj.text_chunk
            }
            if (typeof obj.text === "string") {
                return obj.text
            }
            // Some events provide the full message under `message_content`.
            if (typeof obj.message_content === "string") {
                return obj.message_content
            }
            if (Array.isArray(obj.message_content)) {
                const joined = obj.message_content
                    .map((item) => {
                        if (!item || typeof item !== "object" || Array.isArray(item)) {
                            return ""
                        }
                        const itemObj = item as Record<string, unknown>
                        return typeof itemObj.text === "string"
                            ? itemObj.text
                            : typeof itemObj.content === "string"
                              ? itemObj.content
                              : ""
                    })
                    .filter(Boolean)
                    .join("")
                return joined || null
            }
            return null
        }

        return extractFrom(payloadObj) || extractFrom(payloadObj.data)
    }

    // Set up the server event handler
    const handleServerEventRef = useHandleServerEvent({
        setSessionStatus,
        selectedAgentName,
        selectedAgentConfigSet,
        sendClientEvent,
        setSelectedAgentName, // Pass the real setSelectedAgentName function
        mirrorTurn,
    })

    // Function to send events to the client
    function sendClientEvent(eventObj: any, eventNameSuffix = "") {
        if (eventObj.type === "response.create") {
            if (dcRef.current?.readyState !== "open") return
            responseCoordinatorRef.current?.request({ ...eventObj, event_id: eventObj.event_id || uuidv4() }, eventNameSuffix)
            return
        }
        sendWireEvent(eventObj, eventNameSuffix)
    }

    function sendWireEvent(eventObj: any, eventNameSuffix = "") {
        if (dcRef.current && dcRef.current.readyState === "open") {
            logClientEvent(eventObj, eventNameSuffix)

            try {
                // If this is a special event type, record it for telemetry
                if (
                    eventObj.type === "conversation.item.create" ||
                    eventObj.type === "response.cancel" ||
                    eventObj.type === "session.update" ||
                    eventObj.type === "session.update.after.transfer"
                ) {
                    recordServerEvent(eventObj.type, {
                        itemType: eventObj.item?.type,
                        itemRole: eventObj.item?.role,
                        suffix: eventNameSuffix,

                        agent: eventObj.agent, // For tracking transfers
                    })
                }

                // Special handling for post-transfer session updates
                if (eventObj.type === "session.update.after.transfer") {
                    console.log(`[TRANSFER] Triggering session update after transfer to: ${eventObj.agent}`)
                    // Convert to a regular session update
                    updateSession(false, eventObj.agent)
                    handoffConfiguredAgentRef.current = eventObj.agent
                    return
                }

                // Send the event via data channel
                dcRef.current.send(JSON.stringify(eventObj))
                if (eventObj.type === "conversation.item.create" && eventObj.item?.type === "function_call_output") {
                    responseCoordinatorRef.current?.toolOutputSent(eventObj.item.call_id)
                }
            } catch (error) {
                window.elasticApm?.captureError(`Failed to send message: ${error}`)
                console.error("Failed to send message", error)
                if (eventObj.type === "response.create") responseCoordinatorRef.current?.reset()
            }
        } else {
            logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open")
            console.log("Failed to send message - data channel not open", eventObj.type)
            console.error("Failed to send message - no data channel available", eventObj)
            window.elasticApm?.captureError(`Failed to send message - no data channel available: ${eventObj.type}`)
        }
    }

    // Tokens are short-lived credentials: never put them in the event log.
    const connectToRealtime = async () => {
        if (connectionAbortRef.current || sessionStatus !== "DISCONNECTED") return
        autoConnectAttemptedRef.current = true
        const controller = new AbortController()
        connectionAbortRef.current = controller
        setConnectionError(null)
        setMicrophoneRequired(false)
        setSessionStatus("CONNECTING")
        const startedAt = Date.now()
        let stage: RealtimeConnectionStage = "session_requested"
        const awaitingMicrophone = () => stage === "requesting_microphone"
        const reportStage = (nextStage: RealtimeConnectionStage) => {
            if (controller.signal.aborted) return
            stage = nextStage
            logClientEvent({ type: "connection.stage", stage, elapsedMs: Date.now() - startedAt })
        }
        reportStage("session_requested")
        const timeout = setTimeout(() => {
            setMicrophoneRequired(awaitingMicrophone())
            const message = stage === "requesting_microphone"
                ? "Microphone permission or device initialization timed out. Check the browser's microphone prompt and system microphone access, then select Connect."
                : stage === "session_requested"
                  ? "Voice session creation timed out. Check your connection and select Connect to retry."
                  : stage === "exchanging_sdp"
                    ? "The voice service did not finish the connection exchange. Check your network or VPN and select Connect to retry."
                    : stage === "waiting_for_data_channel" || stage === "answer_received"
                      ? "The voice connection could not open its realtime channel. Check your network or VPN and select Connect to retry."
                      : "Voice connection timed out. Select Connect to retry."
            logClientEvent({ type: "connection.timeout", stage, elapsedMs: Date.now() - startedAt })
            controller.abort(new Error(message))
        }, 30000)
        // Permission prompts can remain pending indefinitely; update the UI when
        // cancelled or timed out even before getUserMedia/SDP has returned.
        controller.signal.addEventListener("abort", () => {
            clearTimeout(timeout)
            if (connectionAbortRef.current === controller) {
                setConnectionError(controller.signal.reason instanceof Error ? controller.signal.reason.message : "Voice connection cancelled.")
                disconnectFromRealtime()
            }
        }, { once: true })

        try {
            const tokenResponse = await fetch("/api/session", { method: "POST", signal: controller.signal, cache: "no-store" })
            const data = await tokenResponse.json()
            logServerEvent({ status: tokenResponse.status, model: data.model }, "fetch_session_token_response")
            if (!tokenResponse.ok || !data.value) {
                throw new Error(typeof data.error === "string" ? data.error : "The server could not create a voice session.")
            }
            controller.signal.throwIfAborted()
            reportStage("session_received")
            if (!audioElementRef.current) audioElementRef.current = document.createElement("audio")
            audioElementRef.current.autoplay = isAudioPlaybackEnabled

            const handleMessage = (event: MessageEvent) => {
                if (controller.signal.aborted) return
                try {
                    const message = JSON.parse(event.data)
                    if (message.type === "input_audio_buffer.speech_started") {
                        responseCoordinatorRef.current?.beginInput()
                        cancelAssistantSpeech()
                    }
                    responseCoordinatorRef.current?.receive(message)
                    if (message.type === "output_audio_buffer.started") audioPlayingRef.current = true
                    if (message.type === "output_audio_buffer.stopped" || message.type === "output_audio_buffer.cleared") audioPlayingRef.current = false
                    handleServerEventRef.current(message)
                    if (message.type === "error" && message.error?.code === "conversation_already_has_active_response") {
                        // A rejected create has no response ID to await. Keep the
                        // real error visible and release media instead of hanging
                        // or blindly retrying into another overlapping response.
                        setConnectionError("Voice replies overlapped. Select Connect to start a fresh session.")
                        disconnectFromRealtime()
                        return
                    }
                    responseCoordinatorRef.current?.flush()
                } catch {
                    logClientEvent({}, "error.invalid_server_event")
                }
            }
            const { pc, dc, localStream: stream } = await createRealtimeConnection(
                data.value, audioElementRef, data.model, controller.signal, handleMessage, setRemoteStream, reportStage,
            )
            controller.signal.throwIfAborted()
            pcRef.current = pc
            dcRef.current = dc
            setLocalStream(stream)
            const handleOpen = () => {
                clearTimeout(timeout)
                reportStage("data_channel_open")
                logClientEvent({}, "data_channel.open")
                setSessionStatus("CONNECTED")
            }
            const handleClose = () => {
                clearTimeout(timeout)
                setConnectionError("Voice connection closed. Select Connect to start a new session.")
                disconnectFromRealtime()
            }
            const handleError = () => {
                clearTimeout(timeout)
                setConnectionError("Voice connection failed. Check your network and select Connect to retry.")
                disconnectFromRealtime()
            }
            dc.addEventListener("open", handleOpen)
            dc.addEventListener("close", handleClose)
            dc.addEventListener("error", handleError)
            pc.addEventListener("connectionstatechange", () => {
                if (pc.connectionState === "failed") handleError()
            })
            dcEventHandlersRef.current = { open: handleOpen, close: handleClose, error: handleError, message: handleMessage }
            setDataChannel(dc)
            if (dc.readyState === "open") handleOpen()
        } catch (err) {
            if (connectionAbortRef.current !== controller) return
            setMicrophoneRequired(awaitingMicrophone())
            const message = err instanceof DOMException && err.name === "NotAllowedError"
                ? "Microphone access was denied. Allow microphone access in your browser, then select Connect."
                : err instanceof Error ? err.message : "Unable to connect to voice. Select Connect to retry."
            setConnectionError(message)
            addTranscriptBreadcrumb(`Connection failed: ${message}`)
            disconnectFromRealtime()
        } finally {
            // Keep the timeout until the data channel opens, rather than only until SDP exchange.
            if (controller.signal.aborted) clearTimeout(timeout)
        }
    }

    // Function to disconnect from the realtime service
    const disconnectFromRealtime = () => {
        handleServerEventRef.current({ type: "session.disconnected" })
        const pending = connectionAbortRef.current
        connectionAbortRef.current = null
        pending?.abort()
        initializedAgentRef.current = null
        configuredPTTRef.current = null
        responseCoordinatorRef.current?.reset()
        audioPlayingRef.current = false
        try {
            // Clean up event listeners from data channel
            if (dcRef.current && dcEventHandlersRef.current) {
                const handlers = dcEventHandlersRef.current
                dcRef.current.removeEventListener("open", handlers.open)
                dcRef.current.removeEventListener("close", handlers.close)
                dcRef.current.removeEventListener("error", handlers.error)
                dcRef.current.removeEventListener("message", handlers.message)
                dcEventHandlersRef.current = null
            }

            // Stop and clean up RTCPeerConnection
            if (pcRef.current) {
                pcRef.current.getSenders().forEach((sender) => {
                    if (sender.track) {
                        sender.track.stop()
                    }
                })

                pcRef.current.close()
                pcRef.current = null
            }

            // Stop local stream tracks if they exist
            if (localStream) {
                localStream.getTracks().forEach((track) => track.stop())
            }

            dcRef.current?.close()
            if (audioElementRef.current) {
                audioElementRef.current.pause()
                audioElementRef.current.srcObject = null
            }
            // Reset state
            setLocalStream(null)
            setRemoteStream(null)
            setAudioPlaybackBlocked(false)
            setDataChannel(null)
            setSessionStatus("DISCONNECTED")
            setIsPTTUserSpeaking(false)
            dcRef.current = null

            logClientEvent({}, "disconnected")
        } catch (error) {
            console.error("Error in disconnectFromRealtime:", error)
            window.elasticApm?.captureError(`Error in disconnectFromRealtime: ${error}`)
        }
    }

    // Toggle connection function
    const onToggleConnection = () => {
        if (!isRealtimeVoiceMode) {
            return
        }

        if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING" || connectionAbortRef.current) {
            deliberatelyDisconnectedRef.current = true
            disconnectFromRealtime()
            setSessionStatus("DISCONNECTED")
        } else {
            deliberatelyDisconnectedRef.current = false
            connectToRealtime()
        }
    }

    // Function to send user text message
    const handleSendTextMessage = async () => {
        const textToSend = userText.trim()
        if (!textToSend) return

        if (isRealtimeVoiceMode) {
            cancelAssistantSpeech()

            sendClientEvent(
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: textToSend }],
                    },
                },
                "(send user text message)",
            )
            setUserText("")

            // Fire-and-forget mirror to Agent Builder for Elastic visibility.
            void mirrorTurn({
                text: textToSend,
                role: "user",
                selectedRealtimeAgentName: selectedAgentName,
                metadata: {
                    inputType: "typed_text",
                },
            })

            sendClientEvent({ type: "response.create" }, "trigger response")
            return
        }

        const userMessageId = uuidv4()
        addTranscriptMessage(userMessageId, "user", textToSend, false, "agent_builder")
        updateTranscriptItemStatus(userMessageId, "DONE")
        setUserText("")
        setIsAgentBuilderSending(true)

        let assistantMessageId: string | null = null
        let finalAssistantText = ""

        try {
            logClientEvent(
                {
                    type: "agent_builder.chat.request",
                    hasConversationId: Boolean(agentBuilderConversationIdRef.current),
                    selectedRealtimeAgentName: selectedAgentName,
                },
                "",
                "agent_builder",
            )

            const abortController = new AbortController()
            const requestTimeoutMs = 120_000
            const requestTimeoutId = window.setTimeout(() => abortController.abort(), requestTimeoutMs)

            const response = await fetch("/api/agent-builder/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    input: textToSend,
                    conversationId: agentBuilderConversationIdRef.current,
                    selectedRealtimeAgentName: selectedAgentName,
                }),
                signal: abortController.signal,
            })

            if (!response.ok) {
                const errorText = await response.text().catch(() => "")
                let message = errorText || response.statusText || "Agent Builder request failed"
                try {
                    const parsed = JSON.parse(errorText)
                    if (typeof parsed?.error === "string") {
                        message = parsed.error
                    } else if (typeof parsed?.details === "string") {
                        message = parsed.details
                    } else if (typeof parsed?.message === "string") {
                        message = parsed.message
                    }
                } catch {
                    // keep raw errorText
                }
                throw new Error(`${message} (HTTP ${response.status})`)
            }

            if (!response.body) {
                throw new Error("Agent Builder stream response was empty.")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            let shouldStop = false

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) {
                        break
                    }
                    if (!value) {
                        continue
                    }

                    buffer += decoder.decode(value, { stream: true })
                    const { frames, remaining } = splitSseFrames(buffer)
                    buffer = remaining

                    for (const frame of frames) {
                        const parsed = parseSseFrame(frame)
                        if (!parsed) {
                            continue
                        }

                        const payload = safeParseSseData(parsed.data)
                        const conversationId = extractConversationIdFromSsePayload(payload)
                        if (conversationId) {
                            agentBuilderConversationIdRef.current = conversationId
                            if (selectedAgentName?.trim()) {
                                agentBuilderConversationIdsByAgentRef.current[selectedAgentName.trim()] = conversationId
                            }
                        }

                        // Kibana Agent Builder SSE event names have varied across releases. We treat any frame
                        // that contains message text as either a delta ("chunk") or a replacement ("message").
                        const content = extractMessageTextFromSsePayload(payload)
                        if (content && content.length > 0) {
                            const payloadObj =
                                payload && typeof payload === "object" && !Array.isArray(payload)
                                    ? (payload as Record<string, unknown>)
                                    : null
                            const nestedObj =
                                payloadObj?.data && typeof payloadObj.data === "object" && !Array.isArray(payloadObj.data)
                                    ? (payloadObj.data as Record<string, unknown>)
                                    : null

                            const isDelta =
                                parsed.event.includes("chunk") ||
                                parsed.event.includes("delta") ||
                                typeof payloadObj?.chunk === "string" ||
                                typeof nestedObj?.chunk === "string" ||
                                typeof payloadObj?.text_chunk === "string" ||
                                typeof nestedObj?.text_chunk === "string"

                            const isFinal =
                                parsed.event.includes("complete") ||
                                parsed.event.includes("round_complete") ||
                                parsed.event.includes("done") ||
                                payloadObj?.done === true ||
                                nestedObj?.done === true

                            if (!assistantMessageId) {
                                assistantMessageId = uuidv4()
                                addTranscriptMessage(assistantMessageId, "assistant", "", false, "agent_builder")
                            }

                            if (isDelta) {
                                finalAssistantText += content
                                updateTranscriptMessage(assistantMessageId, content, true)
                            } else {
                                finalAssistantText = content
                                updateTranscriptMessage(assistantMessageId, content, false)
                            }

                            if (isFinal || parsed.event === "message_complete") {
                                // Terminal event; don't block UI waiting for the upstream stream to close.
                                shouldStop = true
                            }
                        }
                    }

                    if (shouldStop) {
                        break
                    }
                }
            } finally {
                window.clearTimeout(requestTimeoutId)
                if (shouldStop) {
                    try {
                        await reader.cancel()
                    } catch {
                        // ignore
                    }
                }
            }

            if (!assistantMessageId) {
                assistantMessageId = uuidv4()
                addTranscriptMessage(
                    assistantMessageId,
                    "assistant",
                    finalAssistantText || "No response text was returned.",
                    false,
                    "agent_builder",
                )
            }
            updateTranscriptItemStatus(assistantMessageId, "DONE")

            addTranscriptBreadcrumb(
                `Agent Builder text response complete${agentBuilderConversationIdRef.current ? ` (${agentBuilderConversationIdRef.current})` : ""}`,
                {
                    selectedRealtimeAgentName: selectedAgentName,
                    conversationId: agentBuilderConversationIdRef.current,
                },
                "agent_builder",
            )
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Unknown Agent Builder chat failure"

            if (!assistantMessageId) {
                assistantMessageId = uuidv4()
                addTranscriptMessage(
                    assistantMessageId,
                    "assistant",
                    "Agent Builder request failed. Check logs for details.",
                    false,
                    "agent_builder",
                )
            }
            updateTranscriptItemStatus(assistantMessageId, "DONE")

            addTranscriptBreadcrumb("Agent Builder text request failed", { reason }, "agent_builder")
            logServerEvent(
                {
                    type: "agent_builder.chat.error",
                    reason,
                    selectedRealtimeAgentName: selectedAgentName,
                },
                "",
                "agent_builder",
            )
        } finally {
            setIsAgentBuilderSending(false)
        }
    }

    // Function to send simulated user message
    const sendSimulatedUserMessage = (text: string) => {
        const id = uuidv4().slice(0, 32)
        addTranscriptMessage(id, "user", text, true)

        sendClientEvent(
            {
                type: "conversation.item.create",
                item: {
                    id,
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text }],
                },
            },
            "(simulated user text message)",
        )
        sendClientEvent({ type: "response.create" }, "(trigger response after simulated user text message)")
    }

    // Update session configuration
    const updateSession = (shouldTriggerResponse: boolean = false, agentName = selectedAgentName) => {
        updateSessionCounterRef.current++
        console.log(`[SESSION] updateSession with agent: ${selectedAgentName}, trigger: ${shouldTriggerResponse}`)

        const currentAgent = selectedAgentConfigSet?.find((a) => a.name === agentName)
        if (!currentAgent) {
            console.error(`[SESSION] Cannot find agent config for ${selectedAgentName}`)
            window.elasticApm?.captureError(`Cannot find agent config for ${selectedAgentName}`)
            console.log(`[SESSION] Available agents: ${selectedAgentConfigSet?.map((a) => a.name).join(", ")}`)
            return
        }

        console.log(`[SESSION] Found agent config for ${selectedAgentName}`)
        console.log(`[SESSION] Agent has ${currentAgent.tools?.length || 0} tools`)

        if (currentAgent.tools) {
            const hasTransferTool = currentAgent.tools.some((tool) => tool.name === "transferAgents")
            console.log(`[SESSION] Agent has transferAgents tool: ${hasTransferTool}`)

            if (hasTransferTool) {
                const transferTool = currentAgent.tools.find((tool) => tool.name === "transferAgents")
                if (transferTool && transferTool.parameters?.properties?.destination_agent?.enum) {
                    console.log(
                        `[SESSION] Transfer targets: ${transferTool.parameters.properties.destination_agent.enum.join(", ")}`,
                    )
                }
            }
        }

        const turnDetection = isPTTActive
            ? null
            : {
                  type: "server_vad",
                  threshold: 0.7,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  create_response: false,
                  interrupt_response: false,
              }

        // Agent handoffs must not discard speech being collected by VAD.
        // Only startup/input-mode changes intentionally discard buffered audio.
        if (configuredPTTRef.current === null || configuredPTTRef.current !== isPTTActive) {
            responseCoordinatorRef.current?.discardInput()
            sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on input mode change")
        }
        configuredPTTRef.current = isPTTActive

        const instructions = currentAgent?.instructions || ""
        const tools = currentAgent?.tools || []

        const sessionUpdateEvent = {
            type: "session.update",
            session: {
                type: "realtime",
                output_modalities: ["audio"],
                instructions,
                audio: {
                    input: {
                        transcription: { model: "gpt-4o-mini-transcribe" },
                        turn_detection: turnDetection,
                    },
                },
                tools,
            },
        }

        console.log(`[SESSION] Sending session update for ${selectedAgentName}`)
        sendClientEvent(sessionUpdateEvent)
        responseCoordinatorRef.current?.flush()

        if (shouldTriggerResponse) {
            console.log(`[SESSION] Triggering initial response for ${selectedAgentName}`)
            sendSimulatedUserMessage("hi")
        } else {
            console.log(`[SESSION] Session updated for ${selectedAgentName} without triggering response`)
        }
    }

    // WebRTC owns playout timing and truncation; wall-clock message age is not an audio offset.
    const cancelAssistantSpeech = () => {
        responseCoordinatorRef.current?.interrupt()
        if (audioPlayingRef.current) {
            sendClientEvent({ type: "output_audio_buffer.clear" }, "stop assistant playback")
            audioPlayingRef.current = false
        }
    }

    // Push-to-talk handlers
    const handleTalkButtonDown = () => {
        if (!isRealtimeVoiceMode) return
        if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return
        responseCoordinatorRef.current?.beginInput()
        cancelAssistantSpeech()

        setIsPTTUserSpeaking(true)
        localStream?.getAudioTracks().forEach((track) => { track.enabled = true })
        sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer")
    }

    const handleTalkButtonUp = () => {
        if (!isRealtimeVoiceMode) return
        if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return

        setIsPTTUserSpeaking(false)
        localStream?.getAudioTracks().forEach((track) => { track.enabled = false })
        sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT")
    }

    useEffect(() => {
        localStream?.getAudioTracks().forEach((track) => { track.enabled = !isPTTActive || isPTTUserSpeaking })
    }, [localStream, isPTTActive, isPTTUserSpeaking])

    // We use a separate useEffect to initialize from localStorage after component mount

    // Save settings to localStorage (only in browser)
    useEffect(() => {
        if (typeof window !== "undefined") {
            localStorage.setItem("pushToTalkUI", isPTTActive.toString())
        }
    }, [isPTTActive])

    useEffect(() => {
        if (typeof window !== "undefined") {
            localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString())
        }
    }, [isAudioPlaybackEnabled])

    // Called directly by the Enable audio button so browsers receive a user gesture.
    const retryAudioPlayback = () => {
        const audio = audioElementRef.current
        if (!audio?.srcObject) return
        audio.autoplay = true
        setIsAudioPlaybackEnabled(true)
        void audio.play().then(() => setAudioPlaybackBlocked(false)).catch((err) => {
            console.warn("Audio playback could not start:", err)
            if (err instanceof DOMException && err.name === "NotAllowedError") setAudioPlaybackBlocked(true)
        })
    }

    useEffect(() => {
        if (audioElementRef.current && remoteStream) {
            if (isAudioPlaybackEnabled) {
                retryAudioPlayback()
            } else {
                audioElementRef.current.pause()
                setAudioPlaybackBlocked(false)
            }
        }
    }, [isAudioPlaybackEnabled, remoteStream])

    // Ensure realtime connection is disabled in Agent Builder text mode.
    useEffect(() => {
        if (!isRealtimeVoiceMode && (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING")) {
            disconnectFromRealtime()
        }
    }, [isRealtimeVoiceMode, sessionStatus])

    // Defer until mount effects and saved mode/agent settings settle. StrictMode
    // cancels its first scheduled attempt before starting the replayed effect.
    useEffect(() => {
        if (!isRealtimeVoiceMode) {
            autoConnectAttemptedRef.current = false
            return
        }
        if (!selectedAgentConfigSet?.some((agent) => agent.name === selectedAgentName) || sessionStatus !== "DISCONNECTED") return
        if (autoConnectAttemptedRef.current || deliberatelyDisconnectedRef.current) return
        const timer = setTimeout(() => {
            if (autoConnectAttemptedRef.current || deliberatelyDisconnectedRef.current || connectionAbortRef.current) return
            void connectToRealtime()
        }, 0)
        return () => clearTimeout(timer)
    }, [isRealtimeVoiceMode, selectedAgentName, selectedAgentConfigSet, sessionStatus])

    // Release media on unmount; a cancelled startup never becomes a retry loop.
    useEffect(() => () => {
        handleServerEventRef.current({ type: "session.disconnected" })
        responseCoordinatorRef.current?.reset()
        const pending = connectionAbortRef.current
        connectionAbortRef.current = null
        pending?.abort()
        dcRef.current?.close()
        pcRef.current?.getSenders().forEach((sender) => sender.track?.stop())
        pcRef.current?.close()
        if (audioElementRef.current) audioElementRef.current.srcObject = null
    }, [])

    // Configure once per agent/PTT change. A handoff continues from the tool output instead of injecting "hi".
    useEffect(() => {
        if (!isRealtimeVoiceMode || sessionStatus !== "CONNECTED" || !selectedAgentConfigSet || !selectedAgentName) return
        const firstAgent = initializedAgentRef.current === null
        const agentChanged = initializedAgentRef.current !== selectedAgentName
        if (agentChanged) addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`)
        initializedAgentRef.current = selectedAgentName
        if (handoffConfiguredAgentRef.current === selectedAgentName) {
            handoffConfiguredAgentRef.current = null
            return // Already configured synchronously before the introduction response.
        }
        handoffConfiguredAgentRef.current = null
        updateSession(firstAgent)
    }, [selectedAgentConfigSet, selectedAgentName, sessionStatus, isRealtimeVoiceMode, isPTTActive])

    return {
        // Connection state
        sessionStatus,
        connectionError,
        microphoneRequired,
        audioPlaybackBlocked,
        retryAudioPlayback,
        localStream,
        remoteStream,

        // PTT state
        isPTTActive,
        setIsPTTActive,
        isPTTUserSpeaking,

        // Audio state
        isAudioPlaybackEnabled,
        setIsAudioPlaybackEnabled,

        // Text input state
        userText,
        setUserText,

        // Connection actions
        onToggleConnection,

        // Messaging actions
        handleSendTextMessage,

        // PTT actions
        handleTalkButtonDown,
        handleTalkButtonUp,

        // Helper to check if sending is possible
        canSend: isRealtimeVoiceMode ? sessionStatus === "CONNECTED" && dcRef.current?.readyState === "open" : !isAgentBuilderSending,
    }
}
