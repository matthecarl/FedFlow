"use client"

import React, { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { SessionStatus, TranscriptItem } from "@/app/types"
import Image from "next/image"
import { redactEventData } from "./Events"
import { useTranscript } from "@/app/contexts/TranscriptContext"
import { remarkTranscriptLinks } from "@/app/lib/transcript-links"

const transcriptLinkPlugins = [remarkTranscriptLinks]

export interface TranscriptProps {
    userText: string
    setUserText: (val: string) => void
    onSendMessage: () => void
    canSend: boolean
    sessionStatus?: SessionStatus
    prompts?: readonly { label: string; question: string }[]
}

function Transcript({ userText, setUserText, onSendMessage, canSend, sessionStatus = "DISCONNECTED", prompts }: TranscriptProps) {
    const { transcriptItems, toggleTranscriptItemExpand } = useTranscript()
    const transcriptRef = useRef<HTMLDivElement | null>(null)
    const [prevLogs, setPrevLogs] = useState<TranscriptItem[]>([])
    const [justCopied, setJustCopied] = useState(false)
    const inputRef = useRef<HTMLInputElement | null>(null)
    const hasCallerTurn = transcriptItems.some((item) => item.type === "MESSAGE" && item.role === "user" && !item.isHidden && item.status === "DONE")

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
        <div className="conversation-panel">
            <div className="conversation-heading">
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">Conversation</div>
                    <div className="mt-0.5 text-xs text-slate-600">Your questions, answers, and retrieved sources.</div>
                </div>
                <button onClick={handleCopyTranscript} className="btn btn-soft shrink-0" aria-live="polite">
                    {justCopied ? "Copied" : "Copy"}
                </button>
            </div>

            <div className="conversation-body">
                <div ref={transcriptRef} className="transcript-scroll" role="log" aria-label="Conversation transcript">
                    {!transcriptItems.some((item) => !item.isHidden) && (
                        <div className="conversation-empty">
                            <h1>{prompts ? <>Congressional biographies,<br /><span>by voice.</span></> : "Ask a specialist"}</h1>
                            {prompts && <p className="empty-description">Ask BioGuide about a member’s public congressional record. Use the conversation to draft a cited handoff for the next researcher.</p>}
                            <p className="empty-connection" role="status">{sessionStatus === "CONNECTING" ? "Allow microphone access when asked." : sessionStatus === "CONNECTED" ? "Say or type your first question." : "Select Connect to start a call."}</p>
                        </div>
                    )}
                    {transcriptItems.map((item) => {
                        const { itemId, type, role, data, expanded, timestamp, title = "", isHidden } = item

                        if (isHidden) {
                            return null
                        }

                        if (type === "MESSAGE") {
                            const isUser = role === "user"
                            const containerClasses = `flex flex-col ${isUser ? "items-end" : "items-start"}`
                            const bubbleBase = isUser
                                ? "message-bubble rounded-2xl bg-slate-900 px-4 py-3 text-slate-50 shadow-sm"
                                : "message-bubble rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-sm"
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
                                            {timestamp}
                                        </div>
                                        <div className={`mt-1 whitespace-pre-wrap leading-relaxed ${messageStyle}`}>
                                            <ReactMarkdown
                                                disallowedElements={["img"]}
                                                remarkPlugins={!isUser && item.status === "DONE" ? transcriptLinkPlugins : undefined}
                                                components={{
                                                    a: ({ ...props }) => (
                                                        <a
                                                            {...props}
                                                            className="font-semibold text-blue underline underline-offset-2"
                                                            target="_blank"
                                                            rel="noopener noreferrer"
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
                            if (title === "Function result: showArchitecture" && data?.type === "display_image" && data.src === "/architecture.png") {
                                return (
                                    <figure key={itemId} className="overflow-hidden rounded-xl border border-slate-200 bg-white p-3">
                                        <figcaption className="mb-3 text-sm font-semibold text-slate-900">Application architecture</figcaption>
                                        <a href="/architecture.png" target="_blank" rel="noopener noreferrer" aria-label="Open architecture diagram at full size">
                                            <Image src="/architecture.png" alt="Application architecture diagram" width={1526} height={1462} sizes="(max-width: 1024px) 100vw, 760px" className="h-auto w-full" />
                                        </a>
                                        <p className="mt-2 text-xs text-slate-500">Select the diagram to open it at full size.</p>
                                    </figure>
                                )
                            }
                            return (
                                <div
                                    key={itemId}
                                    className="flex flex-col items-start justify-start text-sm text-slate-600"
                                >
                                    <span className="text-[11px] font-mono text-slate-500">
                                        {timestamp}
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
                                        <div className="mt-2 min-w-0 w-full text-left text-slate-900">
                                            <pre className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                                                {JSON.stringify(data, redactEventData, 2)}
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

            {prompts && !hasCallerTurn && (
                <div className="support-prompts" role="group" aria-label="Example support questions">
                    <span className="text-xs font-semibold text-slate-600">Try asking</span>
                    {prompts.map(({ label, question }) => (
                        <button key={question} type="button" className="btn btn-soft" aria-label={question} title={question} onClick={() => {
                            setUserText(question)
                            if (canSend) inputRef.current?.focus()
                        }}>
                            {label}
                        </button>
                    ))}
                </div>
            )}
            <div className="message-composer">
                <input
                    ref={inputRef}
                    type="text"
                    value={userText}
                    onChange={(e) => setUserText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing && canSend && userText.trim()) onSendMessage()
                    }}
                    className="control min-w-0 flex-1"
                    aria-label="Message"
                    placeholder={canSend ? "Type a question or follow up…" : sessionStatus === "CONNECTING" ? "Connecting your microphone…" : "Connect to send…"}
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
