"use client"

import React, { Suspense, useEffect, useRef, useState } from "react"
import { ErrorBoundary } from "react-error-boundary"

// Components
import { Header } from "./components/Header"
import { Main } from "./components/Main"
import BottomToolbar from "./components/BottomToolbar"
import MicrophoneRequiredDialog from "./components/MicrophoneRequiredDialog"

// Custom hooks
import { useAgentSelection } from "./hooks/useAgentSelection"
import { useRealtimeConnection } from "./hooks/useRealtimeConnection"
import { useEventsPaneState } from "./hooks/useEventsPaneState"
import { ConversationMode } from "./types"

// Loading component for Suspense
function Loading() {
    return <div>Loading...</div>
}

// Error Fallback component
function ErrorFallback({ error }: { error: Error }) {
    if (typeof window !== "undefined") window.elasticApm?.captureError(error)
    console.log("error boundary: ", error)
    return (
        <div role="alert" className="app-container py-12">
            <div className="card-solid p-6">
                <h1 className="text-xl font-semibold">The conversation could not continue</h1>
                <p className="mt-2 text-sm text-slate-600">{error.message}</p>
                <button className="btn btn-primary mt-4" onClick={() => window.location.reload()}>Reload application</button>
            </div>
        </div>
    )
}

function Logic() {
    const [conversationMode, setConversationMode] = useState<ConversationMode>("realtime_voice_mirror")
    const shellRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const viewport = window.visualViewport
        const resize = () => {
            // iOS keyboards resize the visual viewport without changing dvh.
            // Leave pinch zoom alone so magnification does not reflow the app.
            if (!viewport || viewport.scale === 1) {
                shellRef.current?.style.setProperty("--app-height", `${viewport?.height ?? window.innerHeight}px`)
            }
        }
        resize()
        viewport?.addEventListener("resize", resize)
        window.addEventListener("resize", resize)
        return () => {
            viewport?.removeEventListener("resize", resize)
            window.removeEventListener("resize", resize)
        }
    }, [])

    useEffect(() => {
        const savedMode = localStorage.getItem("conversationMode")
        if (savedMode === "realtime_voice_mirror" || savedMode === "agent_builder_text") {
            setConversationMode(savedMode)
        }
    }, [])

    useEffect(() => {
        localStorage.setItem("conversationMode", conversationMode)
    }, [conversationMode])

    // Use custom hooks for different aspects of the application
    const { selectedAgentName, setSelectedAgentName, selectedAgentConfigSet, handleSelectedAgentChange, agentSetKey } =
        useAgentSelection()

    const { isEventsPaneExpanded, setIsEventsPaneExpanded } = useEventsPaneState()

    const {
        sessionStatus,
        connectionError,
        microphoneRequired,
        audioPlaybackBlocked,
        retryAudioPlayback,
        localStream,
        remoteStream,
        isPTTActive,
        setIsPTTActive,
        isPTTUserSpeaking,
        isAudioPlaybackEnabled,
        setIsAudioPlaybackEnabled,
        userText,
        setUserText,
        onToggleConnection,
        handleSendTextMessage,
        handleTalkButtonDown,
        handleTalkButtonUp,
        canSend,
    } = useRealtimeConnection({
        selectedAgentName,
        setSelectedAgentName,
        selectedAgentConfigSet,
        conversationMode,
    })

    return (
        <div ref={shellRef} className="app-shell text-slate-900">
            <Header
                agentSetKey={agentSetKey}
                selectedAgentName={selectedAgentName}
                selectedAgentConfigSet={selectedAgentConfigSet}
                onAgentChange={handleSelectedAgentChange}
                conversationMode={conversationMode}
                onConversationModeChange={setConversationMode}
            />

            {microphoneRequired && conversationMode === "realtime_voice_mirror" && (
                <MicrophoneRequiredDialog onRetry={onToggleConnection} />
            )}

            {audioPlaybackBlocked && (
                <div className="app-container app-alert" role="status">
                    <div className="audio-notice">
                        <span>You’re connected. Tap to hear your specialist.</span>
                        <button className="btn btn-primary" onClick={retryAudioPlayback}>Enable audio</button>
                    </div>
                </div>
            )}

            {connectionError && !microphoneRequired && (
                <div className="app-container app-alert" role="alert">
                    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                        <p className="font-semibold">Connection needs attention</p>
                        <p className="mt-1">{connectionError}</p>
                        {sessionStatus === "DISCONNECTED" && (
                            <button className="btn btn-soft mt-3" onClick={onToggleConnection}>Try again</button>
                        )}
                    </div>
                </div>
            )}

            <Main
                userText={userText}
                setUserText={setUserText}
                onSendMessage={handleSendTextMessage}
                canSend={canSend}
                localStream={localStream}
                remoteStream={remoteStream}
                isEventsPaneExpanded={isEventsPaneExpanded}
                sessionStatus={sessionStatus}
                selectedAgentName={selectedAgentName}
                conversationMode={conversationMode}
            />

            <BottomToolbar
                conversationMode={conversationMode}
                sessionStatus={sessionStatus}
                onToggleConnection={onToggleConnection}
                isPTTActive={isPTTActive}
                setIsPTTActive={setIsPTTActive}
                isPTTUserSpeaking={isPTTUserSpeaking}
                handleTalkButtonDown={handleTalkButtonDown}
                handleTalkButtonUp={handleTalkButtonUp}
                isEventsPaneExpanded={isEventsPaneExpanded}
                setIsEventsPaneExpanded={setIsEventsPaneExpanded}
                isAudioPlaybackEnabled={isAudioPlaybackEnabled}
                setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
            />
        </div>
    )
}

export default function App() {
    return (
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <Suspense fallback={<Loading />}>
                <Logic />
            </Suspense>
        </ErrorBoundary>
    )
}
