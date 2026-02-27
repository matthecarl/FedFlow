import { useRef, useState, useEffect } from "react"
import { v4 as uuidv4 } from "uuid"
import { SessionStatus, UseRealtimeConnectionProps } from "@/app/types"
import { createRealtimeConnection } from "@/app/lib/realtimeConnection"
import { parseSseFrame, safeParseSseData, splitSseFrames } from "@/app/lib/agent-builder-sse"
import { useTranscript } from "@/app/contexts/TranscriptContext"
import { useEvent } from "@/app/contexts/EventContext"
import { useHandleServerEvent } from "./useHandleServerEvent"
import { useAgentBuilderMirror } from "./useAgentBuilderMirror"
import { recordServerEvent } from "../lib/client-telemetry"

export function useRealtimeConnection({
    selectedAgentName,
    setSelectedAgentName,
    selectedAgentConfigSet,
    conversationMode,
}: UseRealtimeConnectionProps) {
    const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED")
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
    const manualDisconnectRef = useRef(false)
    const updateSessionCounterRef = useRef(0)
    const dcEventHandlersRef = useRef<{
        open: () => void
        close: () => void
        error: (err: any) => void
        message: (e: MessageEvent) => void
    } | null>(null)
    const agentBuilderConversationIdRef = useRef<string | null>(null)
    const agentBuilderConversationIdsByAgentRef = useRef<Record<string, string>>({})

    const { addTranscriptMessage, addTranscriptBreadcrumb, updateTranscriptMessage, updateTranscriptItemStatus, transcriptItems } =
        useTranscript()
    const { logClientEvent, logServerEvent } = useEvent()
    const { mirrorTurn } = useAgentBuilderMirror()
    const isRealtimeVoiceMode = conversationMode === "realtime_voice_mirror"

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
            if (typeof obj.text === "string") {
                return obj.text
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
                    updateSession(false)
                    return
                }

                // Send the event via data channel
                dcRef.current.send(JSON.stringify(eventObj))
            } catch (error) {
                window.elasticApm?.captureError(`Failed to send message: ${error}`)
                console.error("Failed to send message", error)
            }
        } else {
            logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open")
            console.log("Failed to send message - data channel not open", eventObj.type)
            console.error("Failed to send message - no data channel available", eventObj)
            window.elasticApm?.captureError(`Failed to send message - no data channel available: ${eventObj.type}`)
        }
    }

    // Function to fetch ephemeral key for WebRTC connection
    const fetchEphemeralKey = async (): Promise<string | null> => {
        logClientEvent({ url: "/session" }, "fetch_session_token_request")
        const tokenResponse = await fetch("/api/session")
        const data = await tokenResponse.json()
        logServerEvent(data, "fetch_session_token_response")

        if (!data.client_secret?.value) {
            logClientEvent(data, "error.no_ephemeral_key")
            console.error("No ephemeral key provided by the server")
            window.elasticApm?.captureError(`No ephemeral key provided by the server`)
            setSessionStatus("DISCONNECTED")
            return null
        }

        return data.client_secret.value
    }

    // Function to connect to the realtime service
    const connectToRealtime = async () => {
        if (sessionStatus !== "DISCONNECTED") return
        setSessionStatus("CONNECTING")

        try {
            const EPHEMERAL_KEY = await fetchEphemeralKey()
            if (!EPHEMERAL_KEY) {
                return
            }

            if (!audioElementRef.current) {
                audioElementRef.current = document.createElement("audio")
            }
            audioElementRef.current.autoplay = isAudioPlaybackEnabled

            const { pc, dc, localStream } = await createRealtimeConnection(EPHEMERAL_KEY, audioElementRef)
            pcRef.current = pc
            dcRef.current = dc
            setLocalStream(localStream)

            // Attach remote stream to state once available
            const timeoutId = setTimeout(() => {
                if (audioElementRef.current && audioElementRef.current.srcObject) {
                    setRemoteStream(audioElementRef.current.srcObject as MediaStream)
                }
            }, 1000)

            // Clear timeout on disconnect
            pcRef.current.addEventListener("iceconnectionstatechange", () => {
                if (
                    pcRef.current?.iceConnectionState === "disconnected" ||
                    pcRef.current?.iceConnectionState === "failed" ||
                    pcRef.current?.iceConnectionState === "closed"
                ) {
                    clearTimeout(timeoutId)
                }
            })

            // Set up event handlers for the data channel
            const handleOpen = () => {
                logClientEvent({}, "data_channel.open")
            }

            const handleClose = () => {
                logClientEvent({}, "data_channel.close")
            }

            const handleError = (err: any) => {
                logClientEvent({ error: err }, "data_channel.error")
                window.elasticApm?.captureError(`  Data channel error: ${err}`)
            }

            const handleMessage = (e: MessageEvent) => {
                handleServerEventRef.current(JSON.parse(e.data))
            }

            // Attach event listeners to the data channel
            dc.addEventListener("open", handleOpen)
            dc.addEventListener("close", handleClose)
            dc.addEventListener("error", handleError)
            dc.addEventListener("message", handleMessage)

            // Store handlers for cleanup
            dcEventHandlersRef.current = {
                open: handleOpen,
                close: handleClose,
                error: handleError,
                message: handleMessage,
            }

            setDataChannel(dc)
        } catch (err) {
            console.error("Error connecting to realtime:", err)

            window.elasticApm?.captureError(`Error connecting to realtime: ${err}`)
            window.alert("This app needs access to your microphone, Please enable your microphone")

            setSessionStatus("DISCONNECTED")
        }
    }

    // Function to disconnect from the realtime service
    const disconnectFromRealtime = () => {
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

            // Reset state
            setLocalStream(null)
            setRemoteStream(null)
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

        if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
            manualDisconnectRef.current = true
            disconnectFromRealtime()
            setSessionStatus("DISCONNECTED")
        } else {
            manualDisconnectRef.current = false
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
                const errorText = await response.text()
                throw new Error(errorText || `Agent Builder request failed with status ${response.status}`)
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

                        if (parsed.event === "message_chunk" || parsed.event === "message_complete") {
                            const content = extractMessageTextFromSsePayload(payload)
                            if (content && content.length > 0) {
                                if (!assistantMessageId) {
                                    assistantMessageId = uuidv4()
                                    addTranscriptMessage(assistantMessageId, "assistant", "", false, "agent_builder")
                                }

                                if (parsed.event === "message_chunk") {
                                    finalAssistantText += content
                                    updateTranscriptMessage(assistantMessageId, content, true)
                                } else {
                                    finalAssistantText = content
                                    updateTranscriptMessage(assistantMessageId, content, false)
                                    // Terminal event; don't block UI waiting for the upstream stream to close.
                                    shouldStop = true
                                }
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
    const updateSession = (shouldTriggerResponse: boolean = false) => {
        updateSessionCounterRef.current++
        console.log(`[SESSION] updateSession with agent: ${selectedAgentName}, trigger: ${shouldTriggerResponse}`)
        sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update")

        const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName)
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
                  create_response: true,
              }

        const instructions = currentAgent?.instructions || ""
        const tools = currentAgent?.tools || []

        const sessionUpdateEvent = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions,
                voice: "echo",
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: turnDetection,
                tools,
                temperature: 0.8,
            },
        }

        console.log(`[SESSION] Sending session update for ${selectedAgentName}`)
        sendClientEvent(sessionUpdateEvent)

        if (shouldTriggerResponse) {
            console.log(`[SESSION] Triggering initial response for ${selectedAgentName}`)
            sendSimulatedUserMessage("hi")
        } else {
            console.log(`[SESSION] Session updated for ${selectedAgentName} without triggering response`)
        }
    }

    // Cancel assistant speech
    const cancelAssistantSpeech = async () => {
        const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant")

        if (!mostRecentAssistantMessage) {
            console.warn("can't cancel, no recent assistant message found")
            return
        }
        if (mostRecentAssistantMessage.status === "DONE") {
            console.log("No truncation needed, message is DONE")
            return
        }

        try {
            sendClientEvent({
                type: "conversation.item.truncate",
                item_id: mostRecentAssistantMessage?.itemId,
                content_index: 0,
                audio_end_ms: Date.now() - mostRecentAssistantMessage.createdAtMs,
            })

            // Add a small delay before cancelling the response to ensure proper sequence
            setTimeout(() => {
                try {
                    sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)")
                } catch (error) {
                    console.warn("Error in delayed response.cancel:", error)
                    window.elasticApm?.captureError(`Error in delayed response.cancel: ${error}`)
                }
            }, 50)
        } catch (error) {
            console.warn("Error in cancelAssistantSpeech:", error)
            window.elasticApm?.captureError(`Error in cancelAssistantSpeech: ${error}`)
        }
    }

    // Push-to-talk handlers
    const handleTalkButtonDown = () => {
        if (!isRealtimeVoiceMode) return
        if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return
        cancelAssistantSpeech()

        setIsPTTUserSpeaking(true)
        sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer")
    }

    const handleTalkButtonUp = () => {
        if (!isRealtimeVoiceMode) return
        if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return

        setIsPTTUserSpeaking(false)
        sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT")
        sendClientEvent({ type: "response.create" }, "trigger response PTT")
    }

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

    // Handle audio playback settings
    useEffect(() => {
        if (audioElementRef.current) {
            if (isAudioPlaybackEnabled) {
                audioElementRef.current.play().catch((err) => {
                    console.warn("Autoplay may be blocked by browser:", err)
                })
            } else {
                audioElementRef.current.pause()
            }
        }
    }, [isAudioPlaybackEnabled])

    // Ensure realtime connection is disabled in Agent Builder text mode.
    useEffect(() => {
        if (!isRealtimeVoiceMode && (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING")) {
            manualDisconnectRef.current = true
            disconnectFromRealtime()
        }
    }, [isRealtimeVoiceMode, sessionStatus])

    // Auto-connect when selectedAgentName is set
    useEffect(() => {
        if (isRealtimeVoiceMode && selectedAgentName && sessionStatus === "DISCONNECTED" && !manualDisconnectRef.current) {
            connectToRealtime()
        }
        // Reset the manual disconnect flag when status changes to CONNECTED
        if (sessionStatus === "CONNECTED") {
            manualDisconnectRef.current = false
        }
    }, [selectedAgentName, sessionStatus, isRealtimeVoiceMode])

    // Update session when connected with agent info
    useEffect(() => {
        if (isRealtimeVoiceMode && sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
            const currentAgent = selectedAgentConfigSet.find((a) => a.name === selectedAgentName)
            addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent)
            updateSession(true)
        }
    }, [selectedAgentConfigSet, selectedAgentName, sessionStatus, isRealtimeVoiceMode])

    // Also update session when agent name changes while already connected
    useEffect(() => {
        if (isRealtimeVoiceMode && sessionStatus === "CONNECTED" && selectedAgentName) {
            console.log(`Agent changed to: ${selectedAgentName} - updating session`)
            // Use a small delay to ensure state has propagated
            setTimeout(() => {
                updateSession(false)
            }, 50)
        }
    }, [selectedAgentName, isRealtimeVoiceMode])

    // Update session when PTT status changes
    useEffect(() => {
        if (isRealtimeVoiceMode && sessionStatus === "CONNECTED") {
            console.log(`updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`)
            updateSession()
        }
    }, [isPTTActive, sessionStatus, isRealtimeVoiceMode])

    return {
        // Connection state
        sessionStatus,
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
