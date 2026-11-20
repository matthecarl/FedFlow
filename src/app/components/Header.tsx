import React from "react"
import Image from "next/image"
import { AgentConfig } from "@/app/types"

interface HeaderProps {
    selectedAgentName: string
    selectedAgentConfigSet: AgentConfig[] | null
    onAgentChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
}

export function Header({ selectedAgentName, selectedAgentConfigSet, onAgentChange }: HeaderProps) {
    return (
        <header className="app-header">
            <div className="app-container header-inner">
                <div className="brand">
                    <button onClick={() => window.location.reload()} className="brand-mark" aria-label="Reload application">
                        <Image src="/elastic-glyph.svg" alt="Elastic" width={28} height={28} />
                    </button>
                    <div className="min-w-0">
                        <div className="font-mierb text-lg leading-tight">FedFlow <span className="brand-caption">/ Support desk</span></div>
                    </div>
                </div>
                {selectedAgentConfigSet && (
                    <div className="header-controls">
                        <label htmlFor="agent-select" className="control-label">Agent</label>
                        <select id="agent-select" value={selectedAgentName} onChange={onAgentChange} className="select">
                            {selectedAgentConfigSet.map((agent) => <option key={agent.name} value={agent.name}>{agent.name === "greeter" ? "Greeter" : agent.name}</option>)}
                        </select>
                    </div>
                )}
            </div>
        </header>
    )
}
