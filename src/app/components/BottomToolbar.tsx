import React from "react"
import { ConversationMode, SessionStatus } from "@/app/types"

interface BottomToolbarProps {
    conversationMode: ConversationMode
    sessionStatus: SessionStatus
    onToggleConnection: () => void
    isPTTActive: boolean
    setIsPTTActive: (val: boolean) => void
    isPTTUserSpeaking: boolean
    handleTalkButtonDown: () => void
    handleTalkButtonUp: () => void
    isEventsPaneExpanded: boolean
    setIsEventsPaneExpanded: (val: boolean) => void
    isAudioPlaybackEnabled: boolean
    setIsAudioPlaybackEnabled: (val: boolean) => void
}

function Switch({
    id,
    label,
    checked,
    onChange,
    disabled,
}: {
    id: string
    label: string
    checked: boolean
    onChange: (val: boolean) => void
    disabled?: boolean
}) {
    return (
        <label
            className={`toolbar-switch inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700 ${
                disabled ? "opacity-60 cursor-not-allowed" : ""
            }`}
        >
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                disabled={disabled}
                className="peer sr-only"
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="select-none">{label}</span>
        </label>
    )
}

function BottomToolbar({
    conversationMode,
    sessionStatus,
    onToggleConnection,
    isPTTActive,
    setIsPTTActive,
    isPTTUserSpeaking,
    handleTalkButtonDown,
    handleTalkButtonUp,
    isEventsPaneExpanded,
    setIsEventsPaneExpanded,
    isAudioPlaybackEnabled,
    setIsAudioPlaybackEnabled,
}: BottomToolbarProps) {
    const isRealtimeVoiceMode = conversationMode === "realtime_voice_mirror"
    const isConnected = sessionStatus === "CONNECTED"
    const isConnecting = sessionStatus === "CONNECTING"
    const isVoiceControlsDisabled = !isRealtimeVoiceMode

    const connectionLabel = !isRealtimeVoiceMode
        ? "Text mode active"
        : isConnected
          ? "Disconnect"
          : isConnecting
            ? "Connecting..."
            : "Connect"

    const connectionClasses = !isRealtimeVoiceMode
        ? "btn btn-soft"
        : isConnected
          ? "btn btn-danger"
          : isConnecting
            ? "btn btn-neutral"
            : "btn btn-primary"

    const talkLabel = !isPTTActive ? "Talk" : isPTTUserSpeaking ? "Listening..." : "Hold to talk"

    return (
        <footer className="app-toolbar">
            <div className="app-container toolbar-inner">
                <div className="toolbar-layout">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={onToggleConnection}
                            className={connectionClasses}
                            disabled={isConnecting || isVoiceControlsDisabled}
                        >
                            {connectionLabel}
                        </button>
                        <span className="toolbar-hint">{!isRealtimeVoiceMode ? "Type your question above" : isConnected ? "Microphone connected" : isConnecting ? "Allow microphone access" : "Microphone off"}</span>
                    </div>

                    <div className="toolbar-options">
                        <Switch
                            id="push-to-talk"
                            label="Push to talk"
                            checked={isPTTActive}
                            onChange={setIsPTTActive}
                            disabled={!isConnected || isVoiceControlsDisabled}
                        />
                        {isPTTActive && <button
                            onPointerDown={(event) => {
                                event.currentTarget.setPointerCapture(event.pointerId)
                                handleTalkButtonDown()
                            }}
                            onPointerUp={handleTalkButtonUp}
                            onPointerCancel={handleTalkButtonUp}
                            onKeyDown={(event) => {
                                if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                                    event.preventDefault()
                                    handleTalkButtonDown()
                                }
                            }}
                            onKeyUp={(event) => {
                                if (event.key === " " || event.key === "Enter") {
                                    event.preventDefault()
                                    handleTalkButtonUp()
                                }
                            }}
                            onBlur={() => { if (isPTTUserSpeaking) handleTalkButtonUp() }}
                            disabled={!isConnected || !isPTTActive || isVoiceControlsDisabled}
                            className={
                                "btn " +
                                (!isPTTActive || isVoiceControlsDisabled
                                    ? "btn-soft"
                                    : isPTTUserSpeaking
                                      ? "bg-accent text-slate-900 hover:brightness-95"
                                      : "btn-soft")
                            }
                        >
                            {talkLabel}
                        </button>}

                        <Switch
                            id="audio-playback"
                            label="Audio playback"
                            checked={isAudioPlaybackEnabled}
                            onChange={setIsAudioPlaybackEnabled}
                            disabled={!isConnected || isVoiceControlsDisabled}
                        />
                        <Switch
                            id="logs"
                            label="Logs"
                            checked={isEventsPaneExpanded}
                            onChange={setIsEventsPaneExpanded}
                        />
                    </div>
                </div>
            </div>
        </footer>
    )
}

export default BottomToolbar
