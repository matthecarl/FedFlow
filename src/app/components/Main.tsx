import React from "react"
import Transcript from "./Transcript"
import Events from "./Events"
import AudioDancerComponent from "./AudioDancerComponent"
import { ConversationMode, SessionStatus } from "@/app/types"

interface MainProps {
    userText: string
    setUserText: (text: string) => void
    onSendMessage: () => void
    canSend: boolean
    localStream: MediaStream | null
    remoteStream: MediaStream | null
    isEventsPaneExpanded: boolean
    sessionStatus: SessionStatus
    selectedAgentName: string
    conversationMode: ConversationMode
}

export function Main({
    userText,
    setUserText,
    onSendMessage,
    canSend,
    localStream,
    remoteStream,
    isEventsPaneExpanded,
    sessionStatus,
    selectedAgentName,
    conversationMode,
}: MainProps) {
    const isVoice = conversationMode === "realtime_voice_mirror"
    const sessionLabel = !isVoice ? "Text conversation" : sessionStatus === "CONNECTED" ? "Live conversation" : sessionStatus === "CONNECTING" ? "Connecting your microphone…" : "Session paused"
    const statusDot = sessionStatus === "CONNECTED" ? "bg-emerald-500" : sessionStatus === "CONNECTING" ? "bg-amber-500" : "bg-slate-300"

    return (
        <main className="workspace app-container">
            <div className="session-strip" aria-label="Session information">
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="inline-flex items-center gap-2 text-sm font-semibold" role="status">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
                        {sessionLabel}
                    </span>
                    <span className="agent-badge">{!selectedAgentName || selectedAgentName === "greeter" ? "Your guide" : `${selectedAgentName} specialist`}</span>
                </div>
                <div className="session-visual" aria-hidden="true">
                    <span>One conversation. Connected specialists.</span>
                    <div className="session-glyph">
                        <AudioDancerComponent localStream={localStream} remoteStream={remoteStream} isMobile={true} />
                    </div>
                </div>
            </div>
            <div className={`workspace-panels${isEventsPaneExpanded ? " with-events" : ""}`}>
                <Transcript
                    userText={userText}
                    setUserText={setUserText}
                    onSendMessage={onSendMessage}
                    canSend={canSend}
                    conversationMode={conversationMode}
                    sessionStatus={sessionStatus}
                />
                {isEventsPaneExpanded && <Events isExpanded={true} />}
            </div>
        </main>
    )
}
