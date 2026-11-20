import React from "react"
import Transcript from "./Transcript"
import Events from "./Events"
import AudioDancerComponent from "./AudioDancerComponent"
import { SessionStatus } from "@/app/types"
import { SUPPORT_AGENT, supportPrompts } from "@/app/hooks/useSupportHandoff"
import { getVoiceRoute } from "@/app/lib/voice-routes"

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
    canDraftHandoff: boolean
    hasHandoffRun: boolean
    onDraftHandoff: () => void
    onViewHandoff: () => void
    onSampleCall: () => void
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
    canDraftHandoff,
    hasHandoffRun,
    onDraftHandoff,
    onViewHandoff,
    onSampleCall,
}: MainProps) {
    const sessionLabel = sessionStatus === "CONNECTED" ? "Live conversation" : sessionStatus === "CONNECTING" ? "Connecting voice…" : "Session paused"
    const statusDot = sessionStatus === "CONNECTED" ? "bg-emerald-500" : sessionStatus === "CONNECTING" ? "bg-amber-500" : "bg-slate-300"
    const route = getVoiceRoute(selectedAgentName)

    return (
        <main className="workspace app-container">
            <div className="session-strip" aria-label="Session information">
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="inline-flex items-center gap-2 text-sm font-semibold" role="status">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
                        {sessionLabel}
                    </span>
                    <span className="agent-badge">{!selectedAgentName || selectedAgentName === "greeter" ? "Your guide" : `${selectedAgentName} specialist`}</span>
                    {route && <span className="text-sm text-slate-600">{route.provider} · {route.label}</span>}
                </div>
                <div className="handoff-actions" role="group" aria-label="Support handoff actions">
                    <div className="session-visual" aria-hidden="true">
                        <div className="session-glyph">
                            <AudioDancerComponent localStream={localStream} remoteStream={remoteStream} isMobile={true} />
                        </div>
                    </div>
                    <button type="button" className="btn btn-soft" onClick={onSampleCall}>Try sample call</button>
                    {hasHandoffRun && <button type="button" className="btn btn-soft" onClick={onViewHandoff}>View handoff</button>}
                    {selectedAgentName === SUPPORT_AGENT && (
                        <button type="button" className="btn btn-neutral" onClick={onDraftHandoff} disabled={!canDraftHandoff}>Draft handoff</button>
                    )}
                </div>
            </div>
            <div className={`workspace-panels${isEventsPaneExpanded ? " with-events" : ""}`}>
                <Transcript
                    userText={userText}
                    setUserText={setUserText}
                    onSendMessage={onSendMessage}
                    canSend={canSend}
                    sessionStatus={sessionStatus}
                    prompts={selectedAgentName === SUPPORT_AGENT ? supportPrompts : undefined}
                />
                {isEventsPaneExpanded && <Events isExpanded={true} />}
            </div>
        </main>
    )
}
