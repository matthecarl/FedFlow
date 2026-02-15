import React from "react"
import Image from "next/image"
import { AgentConfig, ConversationMode } from "@/app/types"

interface HeaderProps {
    agentSetKey: string
    selectedAgentName: string
    selectedAgentConfigSet: AgentConfig[] | null
    onAgentChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
    conversationMode: ConversationMode
    onConversationModeChange: (mode: ConversationMode) => void
}

export function Header({
    agentSetKey,
    selectedAgentName,
    selectedAgentConfigSet,
    onAgentChange,
    conversationMode,
    onConversationModeChange,
}: HeaderProps) {
    return (
        <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/70 backdrop-blur">
            <div className="app-container py-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => window.location.reload()}
                            className="inline-flex items-center justify-center rounded-xl p-2 hover:bg-slate-100"
                            aria-label="Reload"
                        >
                            <Image src="/elastic-glyph.svg" alt="Elastic Logo" width={22} height={22} />
                        </button>
                        <div className="min-w-0">
                            <div className="font-mierb text-lg leading-tight text-slate-900">
                                Elastic Realtime <span className="text-primary">Agents</span>
                            </div>
                            <div className="mt-0.5 text-xs text-slate-600">
                                Search, Observability, and Security demo surface.
                            </div>
                        </div>
                    </div>

                    {agentSetKey && (
                        <div className="w-full lg:w-auto">
                            <div className="card px-4 py-3">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(18rem,1fr)_12rem] sm:items-end sm:gap-4">
                                    <div className="min-w-0">
                                        <label
                                            htmlFor="mode-select"
                                            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                                        >
                                            Mode
                                        </label>
                                        <div className="relative min-w-0">
                                            <select
                                                id="mode-select"
                                                value={conversationMode}
                                                onChange={(e) =>
                                                    onConversationModeChange(e.target.value as ConversationMode)
                                                }
                                                className="select h-11 w-full"
                                            >
                                                <option value="realtime_voice_mirror">
                                                    Realtime voice (mirrored to Agent Builder)
                                                </option>
                                                <option value="agent_builder_text">Text via Agent Builder</option>
                                            </select>
                                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">
                                                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                                    <path
                                                        fillRule="evenodd"
                                                        d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                                                        clipRule="evenodd"
                                                    />
                                                </svg>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="min-w-0">
                                        <label
                                            htmlFor="agent-select"
                                            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                                        >
                                            Agent
                                        </label>
                                        <div className="relative min-w-0">
                                            <select
                                                id="agent-select"
                                                value={selectedAgentName}
                                                onChange={onAgentChange}
                                                className="select h-11 w-full"
                                            >
                                                {selectedAgentConfigSet?.map((agent) => (
                                                    <option key={agent.name} value={agent.name}>
                                                        {agent.name}
                                                    </option>
                                                ))}
                                            </select>
                                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">
                                                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                                    <path
                                                        fillRule="evenodd"
                                                        d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                                                        clipRule="evenodd"
                                                    />
                                                </svg>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </header>
    )
}
