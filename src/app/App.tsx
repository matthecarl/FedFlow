"use client"

import React, { Suspense, useEffect, useState } from "react"
import { ErrorBoundary } from "react-error-boundary"

// Components
import { Header } from "./components/Header"
import { Main } from "./components/Main"
import BottomToolbar from "./components/BottomToolbar"

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
    window.elasticApm?.captureError(error)
    console.log("error boundary: ", error)
    return (
        <div role="alert">
            <p>Something went wrong:</p>
            <pre style={{ color: "red" }}>{error.message}</pre>
        </div>
    )
}

function Logic() {
    const [conversationMode, setConversationMode] = useState<ConversationMode>("realtime_voice_mirror")

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
        <div className="flex min-h-dvh flex-col text-slate-900">
            <Header
                agentSetKey={agentSetKey}
                selectedAgentName={selectedAgentName}
                selectedAgentConfigSet={selectedAgentConfigSet}
                onAgentChange={handleSelectedAgentChange}
                conversationMode={conversationMode}
                onConversationModeChange={setConversationMode}
            />

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
