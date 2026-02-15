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
    const gridCols = isEventsPaneExpanded
        ? "lg:grid-cols-[minmax(0,1fr)_320px_minmax(0,440px)]"
        : "lg:grid-cols-[minmax(0,1fr)_320px]"

    const sessionLabel =
        sessionStatus === "CONNECTED" ? "Connected" : sessionStatus === "CONNECTING" ? "Connecting" : "Disconnected"

    const statusDot =
        sessionStatus === "CONNECTED"
            ? "bg-emerald-500"
            : sessionStatus === "CONNECTING"
              ? "bg-amber-500"
              : "bg-slate-300"

    const modeLabel =
        conversationMode === "realtime_voice_mirror" ? "Realtime voice (mirrored)" : "Text via Agent Builder"

    return (
        <main className="flex-1 min-h-0">
            <div className="app-container h-full py-5 sm:py-6">
                <div className={`grid h-full min-h-0 grid-cols-1 gap-4 sm:gap-6 ${gridCols}`}>
                    <div className="min-h-0 relative">
                        {/* Mobile: superimpose the glyph as a subtle background layer. */}
                        <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 opacity-[0.22] lg:hidden">
                            <div className="scale-125">
                                <AudioDancerComponent localStream={localStream} remoteStream={remoteStream} isMobile={true} />
                            </div>
                        </div>

                        <div className="relative z-10 min-h-0">
                            <Transcript
                                userText={userText}
                                setUserText={setUserText}
                                onSendMessage={onSendMessage}
                                canSend={canSend}
                            />
                        </div>

                        {/* Mobile logs: stack below conversation instead of forcing a cramped 3-column layout. */}
                        {isEventsPaneExpanded ? (
                            <div className="mt-4 min-h-[18rem] lg:hidden">
                                <Events isExpanded={true} />
                            </div>
                        ) : null}
                    </div>

                    <aside className="min-h-0 space-y-4 sm:space-y-6">
                        <div className="card-solid p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                        Session
                                    </div>
                                    <div className="mt-1 flex items-center gap-2">
                                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDot}`} />
                                        <span className="text-sm font-semibold text-slate-900">{sessionLabel}</span>
                                    </div>
                                    <div className="mt-2 text-xs text-slate-600">
                                        <span className="font-semibold text-slate-800">Agent:</span> {selectedAgentName}
                                    </div>
                                    <div className="text-xs text-slate-600">
                                        <span className="font-semibold text-slate-800">Mode:</span> {modeLabel}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-4 flex items-center justify-center">
                                <div className="hidden md:block">
                                    <AudioDancerComponent
                                        localStream={localStream}
                                        remoteStream={remoteStream}
                                        isMobile={false}
                                    />
                                </div>
                            </div>

                            <div className="mt-3 text-xs text-slate-600">
                                Voice activity animates the Elastic glyph when audio is flowing.
                            </div>
                        </div>

                        <div className="card-solid p-4">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                Shortcuts
                            </div>
                            <div className="mt-2 space-y-2 text-sm text-slate-700">
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-slate-700">Send message</span>
                                    <span className="kbd">Enter</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-slate-700">Copy transcript</span>
                                    <span className="kbd">Copy</span>
                                </div>
                            </div>
                        </div>
                    </aside>

                    {isEventsPaneExpanded ? (
                        <div className="min-h-0 hidden lg:block">
                            <Events isExpanded={true} />
                        </div>
                    ) : null}
                </div>
            </div>
        </main>
    )
}
