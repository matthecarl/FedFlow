"use client"

import { useRef } from "react"
import { v4 as uuidv4 } from "uuid"
import { MirrorTurnRequest, MirrorTurnResult } from "@/app/types"
import { useEvent } from "@/app/contexts/EventContext"
import { useTranscript } from "@/app/contexts/TranscriptContext"

const DEFAULT_AGENT_ID = "elastic-ai-agent"
const MIRROR_REQUEST_TIMEOUT_MS = 125_000
const MIRROR_MAX_CONSECUTIVE_FAILURES = 5
const MIRROR_CIRCUIT_OPEN_MS = 60_000

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useAgentBuilderMirror() {
    const { logClientEvent, logServerEvent } = useEvent()
    const { addTranscriptBreadcrumb } = useTranscript()

    const conversationIdsByAgentRef = useRef<Record<string, string>>({})
    const consecutiveFailuresRef = useRef(0)
    const circuitOpenUntilRef = useRef<number | null>(null)

    const mirrorTurn = async (request: MirrorTurnRequest): Promise<MirrorTurnResult> => {
        const text = request.text?.trim() ?? ""
        const selectedRealtimeAgentName = request.selectedRealtimeAgentName?.trim() || "unknown"

        const now = Date.now()
        const circuitOpenUntil = circuitOpenUntilRef.current
        if (circuitOpenUntil && now < circuitOpenUntil) {
            const skippedResult: MirrorTurnResult = {
                success: true,
                status: "skipped",
                conversationId: request.conversationId ?? null,
                agentId: DEFAULT_AGENT_ID,
                mappedFromRealtimeAgent: selectedRealtimeAgentName,
                reason: `Mirror circuit open until ${new Date(circuitOpenUntil).toISOString()}`,
            }

            addTranscriptBreadcrumb("Mirror skipped (circuit open)", skippedResult, "agent_builder_mirror")
            return skippedResult
        }

        if (!text) {
            const emptyResult: MirrorTurnResult = {
                success: false,
                status: "failed",
                conversationId: null,
                agentId: DEFAULT_AGENT_ID,
                mappedFromRealtimeAgent: selectedRealtimeAgentName,
                reason: "Mirror text is empty",
            }

            addTranscriptBreadcrumb("Mirror skipped (empty text)", emptyResult, "agent_builder_mirror")
            return emptyResult
        }

        const agentKey = selectedRealtimeAgentName
        // Do not use a cross-agent "default" conversation id fallback; that leaks context between agents.
        const knownConversationId = request.conversationId || conversationIdsByAgentRef.current[agentKey] || null

        if (request.role === "assistant" && !knownConversationId) {
            const skippedResult: MirrorTurnResult = {
                success: true,
                status: "skipped",
                conversationId: null,
                agentId: DEFAULT_AGENT_ID,
                mappedFromRealtimeAgent: selectedRealtimeAgentName,
                reason: "Skipping assistant mirror until a user turn creates an Agent Builder conversation.",
            }

            addTranscriptBreadcrumb("Mirror assistant turn skipped (awaiting user mirror)", skippedResult, "agent_builder_mirror")
            return skippedResult
        }

        const requestPayload = {
            ...request,
            text,
            selectedRealtimeAgentName,
            conversationId: knownConversationId,
        }

        logClientEvent(
            {
                type: "agent_builder.mirror.request",
                role: request.role,
                selectedRealtimeAgentName,
                hasConversationId: Boolean(knownConversationId),
            },
            "",
            "agent_builder_mirror",
        )

        const attemptMirror = async (): Promise<{ result: MirrorTurnResult; retryable: boolean }> => {
            const abortController = new AbortController()
            const timeoutId = window.setTimeout(() => abortController.abort(), MIRROR_REQUEST_TIMEOUT_MS)

            try {
                const response = await fetch("/api/agent-builder/mirror", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(requestPayload),
                    signal: abortController.signal,
                })

                const payload = await response.json().catch(() => ({}))

                if (!response.ok) {
                    const reason =
                        typeof payload?.error === "string" ? payload.error : `Mirror API returned HTTP ${response.status}`

                    const isRetryableStatus = response.status >= 500 || response.status === 408 || response.status === 429
                    return {
                        result: {
                            success: false,
                            status: "failed",
                            conversationId: knownConversationId,
                            agentId: typeof payload?.agentId === "string" ? payload.agentId : DEFAULT_AGENT_ID,
                            mappedFromRealtimeAgent: selectedRealtimeAgentName,
                            reason,
                        },
                        retryable: isRetryableStatus,
                    }
                }

                return {
                    result: {
                        success: Boolean(payload?.success),
                        status:
                            payload?.status === "mirrored" || payload?.status === "skipped" || payload?.status === "failed"
                                ? payload.status
                                : "failed",
                        conversationId: typeof payload?.conversationId === "string" ? payload.conversationId : knownConversationId,
                        agentId: typeof payload?.agentId === "string" ? payload.agentId : DEFAULT_AGENT_ID,
                        mappedFromRealtimeAgent:
                            typeof payload?.mappedFromRealtimeAgent === "string"
                                ? payload.mappedFromRealtimeAgent
                                : selectedRealtimeAgentName,
                        reason: typeof payload?.reason === "string" ? payload.reason : undefined,
                    },
                    retryable: false,
                }
            } catch (error) {
                const isAbort = error instanceof Error && error.name === "AbortError"
                if (isAbort) {
                    return {
                        result: {
                            success: true,
                            status: "skipped",
                            conversationId: knownConversationId,
                            agentId: DEFAULT_AGENT_ID,
                            mappedFromRealtimeAgent: selectedRealtimeAgentName,
                            reason: "Mirror request timed out before Agent Builder completed.",
                        },
                        retryable: false,
                    }
                }

                const reason = error instanceof Error ? error.message : "Mirror API request failed"
                return {
                    result: {
                        success: false,
                        status: "failed",
                        conversationId: knownConversationId,
                        agentId: DEFAULT_AGENT_ID,
                        mappedFromRealtimeAgent: selectedRealtimeAgentName,
                        reason,
                    },
                    retryable: true,
                }
            } finally {
                window.clearTimeout(timeoutId)
            }
        }

        const attempt = await attemptMirror()
        let result = attempt.result
        const initialRetryable = attempt.retryable

        if (!result.success && initialRetryable) {
            await sleep(500)
            ;({ result } = await attemptMirror())
        }

        if (result.success) {
            consecutiveFailuresRef.current = 0
            circuitOpenUntilRef.current = null
        } else if (result.status === "failed") {
            consecutiveFailuresRef.current += 1
            if (consecutiveFailuresRef.current >= MIRROR_MAX_CONSECUTIVE_FAILURES) {
                circuitOpenUntilRef.current = Date.now() + MIRROR_CIRCUIT_OPEN_MS
                consecutiveFailuresRef.current = 0
            }
        }

        if (result.conversationId) {
            conversationIdsByAgentRef.current[agentKey] = result.conversationId
        }

        logServerEvent(
            {
                type: "agent_builder.mirror.result",
                role: request.role,
                selectedRealtimeAgentName,
                ...result,
            },
            "",
            "agent_builder_mirror",
        )

        const mirrorLabel = result.success
            ? `Mirror ${request.role} turn ${result.status}${result.conversationId ? ` (${result.conversationId})` : ""}`
            : `Mirror ${request.role} turn failed`

        addTranscriptBreadcrumb(
            mirrorLabel,
            {
                selectedRealtimeAgentName,
                ...result,
            },
            "agent_builder_mirror",
        )

        const persistConversationId = result.conversationId || `mirror-${selectedRealtimeAgentName}`
        const roundId = uuidv4()

        try {
            await fetch("/api/agent-builder/events", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    conversationId: persistConversationId,
                    agentId: result.agentId || DEFAULT_AGENT_ID,
                    roundId,
                    events: [
                        {
                            eventType: `realtime.${request.role}_turn`,
                            timestamp: new Date().toISOString(),
                            role: request.role,
                            content: text,
                            status: "complete",
                            sourceBackend: "realtime",
                            mirrorStatus: "not_attempted",
                            mappedAgentId: result.agentId || DEFAULT_AGENT_ID,
                            realtimeAgentName: selectedRealtimeAgentName,
                            raw: {
                                metadata: request.metadata,
                            },
                        },
                        {
                            eventType: `agent_builder_mirror.${request.role}_turn`,
                            timestamp: new Date().toISOString(),
                            role: request.role,
                            content: text,
                            status: result.success ? "complete" : "error",
                            sourceBackend: "agent_builder_mirror",
                            mirrorStatus: result.status,
                            mappedAgentId: result.agentId || DEFAULT_AGENT_ID,
                            realtimeAgentName: selectedRealtimeAgentName,
                            raw: {
                                reason: result.reason,
                                metadata: request.metadata,
                            },
                        },
                    ],
                }),
            })
        } catch (error) {
            console.warn("Failed to persist mirror events", error)
        }

        return result
    }

    return {
        mirrorTurn,
    }
}

