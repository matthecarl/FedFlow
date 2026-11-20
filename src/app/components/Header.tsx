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

export function Header({ agentSetKey, selectedAgentName, selectedAgentConfigSet, onAgentChange, conversationMode, onConversationModeChange }: HeaderProps) {
    return (
        <header className="app-header">
            <div className="app-container header-inner">
                <div className="brand">
                    <button onClick={() => window.location.reload()} className="brand-mark" aria-label="Reload application">
                        <Image src="/elastic-glyph.svg" alt="Elastic" width={28} height={28} />
                    </button>
                    <div className="min-w-0">
                        <div className="font-mierb text-lg leading-tight">FedFlow <span className="brand-caption">/ Realtime agents</span></div>
                        <p className="brand-subtitle">One conversation. The right specialist.</p>
                    </div>
                </div>
                {agentSetKey && (
                    <div className="header-controls">
                        <div className="min-w-0">
                            <label htmlFor="mode-select" className="control-label">Mode</label>
                            <select id="mode-select" value={conversationMode} onChange={(e) => onConversationModeChange(e.target.value as ConversationMode)} className="select">
                                <option value="realtime_voice_mirror">Realtime voice</option>
                                <option value="agent_builder_text">Text via Agent Builder</option>
                            </select>
                        </div>
                        <div className="min-w-0">
                            <label htmlFor="agent-select" className="control-label">Agent</label>
                            <select id="agent-select" value={selectedAgentName} onChange={onAgentChange} className="select">
                                {selectedAgentConfigSet?.map((agent) => <option key={agent.name} value={agent.name}>{agent.name === "greeter" ? "Greeter" : agent.name}</option>)}
                            </select>
                        </div>
                    </div>
                )}
            </div>
        </header>
    )
}
