import { useRef, useState, useEffect } from "react"
import { v4 as uuidv4 } from "uuid"
import { SessionStatus, UseRealtimeConnectionProps } from "@/app/types"
import { createRealtimeConnection, RealtimeConnectionStage } from "@/app/lib/realtimeConnection"
import { useTranscript } from "@/app/contexts/TranscriptContext"
import { useEvent } from "@/app/contexts/EventContext"
import { useHandleServerEvent } from "./useHandleServerEvent"
import { recordServerEvent } from "../lib/client-telemetry"
import { RealtimeResponseCoordinator } from "@/app/lib/realtimeResponseCoordinator"

export function useRealtimeConnection({
    selectedAgentName,
    setSelectedAgentName,
    selectedAgentConfigSet,
    autoConnect = true,
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

    // References
    const pcRef = useRef<RTCPeerConnection | null>(null)
    const dcRef = useRef<RTCDataChannel | null>(null)
    const audioElementRef = useRef<HTMLAudioElement | null>(null)
    const dcEventHandlersRef = useRef<{
        open: () => void
        close: () => void
        error: (err: any) => void
        message: (e: MessageEvent) => void
    } | null>(null)

    const { addTranscriptMessage, addTranscriptBreadcrumb } = useTranscript()
    const { logClientEvent, logServerEvent } = useEvent()
    if (!responseCoordinatorRef.current) {
        responseCoordinatorRef.current = new RealtimeResponseCoordinator(sendWireEvent, uuidv4)
    }

    // Set up the server event handler
    const handleServerEventRef = useHandleServerEvent({
        setSessionStatus,
        selectedAgentName,
        selectedAgentConfigSet,
        sendClientEvent,
        setSelectedAgentName, // Pass the real setSelectedAgentName function
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
        if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING" || connectionAbortRef.current) {
            deliberatelyDisconnectedRef.current = true
            disconnectFromRealtime()
            setSessionStatus("DISCONNECTED")
        } else {
            deliberatelyDisconnectedRef.current = false
            connectToRealtime()
        }
    }

    const handleSendTextMessage = () => {
        const textToSend = userText.trim()
        if (!textToSend || dcRef.current?.readyState !== "open") return

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
        sendClientEvent({ type: "response.create" }, "trigger response")
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
        if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return
        responseCoordinatorRef.current?.beginInput()
        cancelAssistantSpeech()

        setIsPTTUserSpeaking(true)
        localStream?.getAudioTracks().forEach((track) => { track.enabled = true })
        sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer")
    }

    const handleTalkButtonUp = () => {
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

    // Defer until mount effects and agent settings settle. StrictMode
    // cancels its first scheduled attempt before starting the replayed effect.
    useEffect(() => {
        if (!autoConnect) return
        if (!selectedAgentConfigSet?.some((agent) => agent.name === selectedAgentName) || sessionStatus !== "DISCONNECTED") return
        if (autoConnectAttemptedRef.current || deliberatelyDisconnectedRef.current) return
        const timer = setTimeout(() => {
            if (autoConnectAttemptedRef.current || deliberatelyDisconnectedRef.current || connectionAbortRef.current) return
            void connectToRealtime()
        }, 0)
        return () => clearTimeout(timer)
    }, [autoConnect, selectedAgentName, selectedAgentConfigSet, sessionStatus])

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
        if (sessionStatus !== "CONNECTED" || !selectedAgentConfigSet || !selectedAgentName) return
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
    }, [selectedAgentConfigSet, selectedAgentName, sessionStatus, isPTTActive])

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
        canSend: sessionStatus === "CONNECTED" && dcRef.current?.readyState === "open",
    }
}
