"use client"

import React, { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { TranscriptItem } from "@/app/types"
import Image from "next/image"
import { useTranscript } from "@/app/contexts/TranscriptContext"

export interface TranscriptProps {
    userText: string
    setUserText: (val: string) => void
    onSendMessage: () => void
    canSend: boolean
}

function Transcript({ userText, setUserText, onSendMessage, canSend }: TranscriptProps) {
    const { transcriptItems, toggleTranscriptItemExpand } = useTranscript()
    const transcriptRef = useRef<HTMLDivElement | null>(null)
    const [prevLogs, setPrevLogs] = useState<TranscriptItem[]>([])
    const [justCopied, setJustCopied] = useState(false)
    const inputRef = useRef<HTMLInputElement | null>(null)

    function scrollToBottom() {
        if (transcriptRef.current) {
            transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
        }
    }

    useEffect(() => {
        const hasNewMessage = transcriptItems.length > prevLogs.length
        const hasUpdatedMessage = transcriptItems.some((newItem, index) => {
            const oldItem = prevLogs[index]
            return oldItem && (newItem.title !== oldItem.title || newItem.data !== oldItem.data)
        })

        if (hasNewMessage || hasUpdatedMessage) {
            scrollToBottom()
        }

        setPrevLogs(transcriptItems)
    }, [transcriptItems])

    // Autofocus on text box input on load
    useEffect(() => {
        if (canSend && inputRef.current) {
            inputRef.current.focus()
        }
    }, [canSend])

    const handleCopyTranscript = async () => {
        if (!transcriptRef.current) return
        try {
            await navigator.clipboard.writeText(transcriptRef.current.innerText)
            setJustCopied(true)
            setTimeout(() => setJustCopied(false), 1500)
        } catch (error) {
            console.error("Failed to copy transcript:", error)
        }
    }

    return (
        <div className="flex min-h-0 flex-col rounded-2xl border border-slate-200/80 bg-white/70 shadow-sm backdrop-blur sm:bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white/70 px-4 py-3 backdrop-blur">
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">Conversation</div>
                    <div className="mt-0.5 text-xs text-slate-600">Messages and system breadcrumbs.</div>
                </div>
                <button onClick={handleCopyTranscript} className="btn btn-soft shrink-0" aria-live="polite">
                    {justCopied ? "Copied" : "Copy"}
                </button>
            </div>

            <div className="relative flex-1 min-h-0">
                <div ref={transcriptRef} className="h-full overflow-auto p-4 space-y-4">
                    {transcriptItems.map((item) => {
                        const { itemId, type, role, data, expanded, timestamp, title = "", isHidden, sourceBackend } = item

                        if (isHidden) {
                            return null
                        }

                        if (type === "MESSAGE") {
                            const isUser = role === "user"
                            const containerClasses = `flex flex-col ${isUser ? "items-end" : "items-start"}`
                            const bubbleBase = isUser
                                ? "max-w-lg rounded-2xl bg-slate-900 px-4 py-3 text-slate-50 shadow-sm"
                                : "max-w-lg rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-sm"
                            const isBracketedMessage = title.startsWith("[") && title.endsWith("]")
                            const messageStyle = isBracketedMessage ? "italic text-gray-400" : ""
                            const displayTitle = isBracketedMessage ? title.slice(1, -1) : title

                            return (
                                <div key={itemId} className={containerClasses}>
                                    <div className={bubbleBase}>
                                        <div
                                            className={`text-[11px] font-mono ${
                                                isUser ? "text-slate-300" : "text-slate-500"
                                            }`}
                                        >
                                            {timestamp}{" "}
                                            {sourceBackend && (
                                                <span className="ml-1 uppercase tracking-wide">[{sourceBackend}]</span>
                                            )}
                                        </div>
                                        <div className={`mt-1 whitespace-pre-wrap leading-relaxed ${messageStyle}`}>
                                            <ReactMarkdown
                                                components={{
                                                    a: ({ ...props }) => (
                                                        <a
                                                            {...props}
                                                            className="font-semibold text-blue hover:underline"
                                                        />
                                                    ),
                                                }}
                                            >
                                                {displayTitle}
                                            </ReactMarkdown>
                                        </div>
                                    </div>
                                </div>
                            )
                        } else if (type === "BREADCRUMB") {
                            return (
                                <div
                                    key={itemId}
                                    className="flex flex-col items-start justify-start text-sm text-slate-600"
                                >
                                    <span className="text-[11px] font-mono text-slate-500">
                                        {timestamp}{" "}
                                        {sourceBackend && (
                                            <span className="ml-1 uppercase tracking-wide">[{sourceBackend}]</span>
                                        )}
                                    </span>
                                    <div
                                        className={`mt-1 flex items-center whitespace-pre-wrap rounded-xl border border-transparent px-2 py-1 font-mono text-sm text-slate-900 ${
                                            data ? "cursor-pointer" : ""
                                        }`}
                                        onClick={() => data && toggleTranscriptItemExpand(itemId)}
                                    >
                                        {data && (
                                            <span
                                                className={`mr-2 select-none font-mono text-slate-400 transition-transform duration-200 ${
                                                    expanded ? "rotate-90" : "rotate-0"
                                                }`}
                                            >
                                                ▶
                                            </span>
                                        )}
                                        {title}
                                    </div>
                                    {expanded && data && (
                                        <div className="mt-2 text-left text-slate-900">
                                            <pre className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                                                {JSON.stringify(data, null, 2)}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            )
                        } else {
                            // Fallback if type is neither MESSAGE nor BREADCRUMB
                            return (
                                <div
                                    key={itemId}
                                    className="flex justify-center font-mono text-sm italic text-slate-500"
                                >
                                    Unknown item type: {type} <span className="ml-2 text-xs">{timestamp}</span>
                                </div>
                            )
                        }
                    })}
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white/70 p-3 backdrop-blur sm:p-4">
                <input
                    ref={inputRef}
                    type="text"
                    value={userText}
                    onChange={(e) => setUserText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && canSend) onSendMessage()
                    }}
                    className="control flex-1"
                    placeholder="Type a message..."
                />
                <button
                    onClick={onSendMessage}
                    disabled={!canSend || !userText.trim()}
                    className="btn btn-primary h-11 w-11 shrink-0 rounded-full p-0"
                    aria-label="Send message"
                >
                    <Image src="/arrow.svg" alt="" width={20} height={20} />
                </button>
            </div>
        </div>
    )
}

export default Transcript
