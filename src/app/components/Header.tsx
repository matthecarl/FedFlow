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
        <div className="p-5 text-lg font-semibold flex flex-col sm:flex-row justify-between items-center">
            {/* Left Section: Logo and Title */}
            <div className="flex items-center mb-3 sm:mb-0 w-full sm:w-auto">
                <div onClick={() => window.location.reload()} className="cursor-pointer">
                    <Image src="/elastic-glyph.svg" alt="Elastic Logo" width={20} height={20} className="mr-2" />
                </div>
                <div className="font-mierb">
                    Elastic Realtime <span className="text-primary">Agents</span>
                </div>
            </div>

            {/* Right Section: Mode + Agent Select */}
            {agentSetKey && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
                    <div className="flex items-center w-full sm:w-auto">
                        <label className="flex items-center text-base gap-1 mr-2 font-medium whitespace-nowrap">
                            Mode
                        </label>
                        <div className="relative inline-block w-full sm:w-auto min-w-[22rem]">
                            <select
                                value={conversationMode}
                                onChange={(e) => onConversationModeChange(e.target.value as ConversationMode)}
                                className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none w-full"
                            >
                                <option value="realtime_voice_mirror">Realtime voice (mirrored to Agent Builder)</option>
                                <option value="agent_builder_text">Text via Agent Builder</option>
                            </select>
                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
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
                    <div className="flex items-center w-full sm:w-auto">
                        <label className="flex items-center text-base gap-1 mr-2 font-medium whitespace-nowrap">
                            Agent
                        </label>
                        <div className="relative inline-block w-full sm:w-auto">
                            <select
                                value={selectedAgentName}
                                onChange={onAgentChange}
                                className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none w-full"
                            >
                                {selectedAgentConfigSet?.map((agent) => (
                                    <option key={agent.name} value={agent.name}>
                                        {agent.name}
                                    </option>
                                ))}
                            </select>
                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                                {/* downward-facing chevron (caret) icon */}
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
            )}
        </div>
    )
}
