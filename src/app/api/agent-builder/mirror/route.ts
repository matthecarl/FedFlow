import { NextRequest, NextResponse } from "next/server"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { parseSseFrame, safeParseSseData, splitSseFrames } from "@/app/lib/agent-builder-sse"
import {
    asOptionalNonEmptyString,
    resolveAuthorizationHeader as resolveAuthorizationHeaderShared,
    resolveConverseUrl as resolveConverseUrlShared,
    resolveMappedAgentId as resolveMappedAgentIdShared,
} from "@/app/lib/agent-builder-kibana"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const tracer = trace.getTracer("agent-builder-api")
const DEFAULT_AGENT_ID = "elastic-ai-agent"
const MAX_INPUT_LENGTH = 8000
const MIRROR_CONVERSE_TIMEOUT_MS = 120_000

type MirrorRole = "user" | "assistant"

interface MirrorRouteBody {
    text?: unknown
    role?: unknown
    selectedRealtimeAgentName?: unknown
    conversationId?: unknown
    metadata?: unknown
}

function asOptionalString(value: unknown): string | undefined {
    return asOptionalNonEmptyString(value)
}

function resolveAuthorizationHeader(): string {
    return resolveAuthorizationHeaderShared()
}

function resolveConverseUrl(): string {
    return resolveConverseUrlShared()
}

function resolveMappedAgentId(realtimeAgentName?: string): { mappedAgentId: string; mappedFromRealtimeAgent?: string } {
    return resolveMappedAgentIdShared(realtimeAgentName)
}

function extractConversationId(payload: unknown): string | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null
    }

    const payloadObj = payload as Record<string, unknown>
    const dataObj = payloadObj.data

    if (typeof payloadObj.conversation_id === "string" && payloadObj.conversation_id.trim()) {
        return payloadObj.conversation_id.trim()
    }

    if (typeof payloadObj.conversationId === "string" && payloadObj.conversationId.trim()) {
        return payloadObj.conversationId.trim()
    }

    if (dataObj && typeof dataObj === "object" && !Array.isArray(dataObj)) {
        const nested = dataObj as Record<string, unknown>

        if (typeof nested.conversation_id === "string" && nested.conversation_id.trim()) {
            return nested.conversation_id.trim()
        }

        if (typeof nested.conversationId === "string" && nested.conversationId.trim()) {
            return nested.conversationId.trim()
        }
    }

    return null
}

interface SseMirrorResult {
    conversationId: string | null
    persisted: boolean
}

async function readConversationResultFromSse(stream: ReadableStream<Uint8Array>): Promise<SseMirrorResult> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let conversationId: string | null = null
    let bytesRead = 0
    let persisted = false
    let doneReading = false

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                doneReading = true
                break
            }

            if (!value) {
                continue
            }

            bytesRead += value.byteLength
            if (bytesRead > 2_000_000) {
                break
            }

            buffer += decoder.decode(value, { stream: true })
            const { frames, remaining } = splitSseFrames(buffer)
            buffer = remaining

            for (const frame of frames) {
                const parsed = parseSseFrame(frame)
                if (!parsed) {
                    continue
                }

                const eventPayload = safeParseSseData(parsed.data)
                const extractedConversationId = extractConversationId(eventPayload)
                if (extractedConversationId) {
                    conversationId = extractedConversationId
                }

                if (parsed.event === "conversation_created" || parsed.event === "round_complete") {
                    persisted = true
                }
            }

            if (conversationId && persisted) {
                break
            }
        }
    } finally {
        if (!doneReading) {
            await reader.cancel()
        }
    }

    return {
        conversationId,
        persisted,
    }
}

export async function POST(req: NextRequest) {
    const span = tracer.startSpan("agent_builder.mirror", {
        kind: SpanKind.SERVER,
        attributes: {
            "gen_ai.system": "elastic_agent_builder",
            "gen_ai.operation.name": "mirror_turn",
            "http.method": "POST",
            "http.route": "/api/agent-builder/mirror",
        },
    })

    try {
        const body = (await req.json()) as MirrorRouteBody
        const text = asOptionalString(body.text)
        const selectedRealtimeAgentName = asOptionalString(body.selectedRealtimeAgentName)
        const conversationId = asOptionalString(body.conversationId)
        const role = asOptionalString(body.role) as MirrorRole | undefined

        if (!text) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Missing text" })
            span.end()
            return NextResponse.json({ error: "Missing required `text` string." }, { status: 400 })
        }

        if (!role || (role !== "user" && role !== "assistant")) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Invalid role" })
            span.end()
            return NextResponse.json({ error: "Role must be either `user` or `assistant`." }, { status: 400 })
        }

        if (text.length > MAX_INPUT_LENGTH) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Input too large" })
            span.end()
            return NextResponse.json({ error: `Input exceeds ${MAX_INPUT_LENGTH} characters.` }, { status: 400 })
        }

        const { mappedAgentId, mappedFromRealtimeAgent } = resolveMappedAgentId(selectedRealtimeAgentName)

        span.setAttribute("gen_ai.agent.id", mappedAgentId)
        if (selectedRealtimeAgentName) {
            span.setAttribute("gen_ai.realtime.agent_name", selectedRealtimeAgentName)
        }

        if (role === "assistant") {
            span.setStatus({ code: SpanStatusCode.OK })
            span.end()
            return NextResponse.json({
                success: true,
                status: "skipped",
                conversationId: conversationId || null,
                agentId: mappedAgentId,
                mappedFromRealtimeAgent: mappedFromRealtimeAgent || null,
                reason: "Assistant turns are indexed for visibility but not replayed into Agent Builder conversations.",
            })
        }

        const converseUrl = resolveConverseUrl()
        const authorization = resolveAuthorizationHeader()

        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), MIRROR_CONVERSE_TIMEOUT_MS)

        let response: Response
        try {
            response = await fetch(converseUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "kbn-xsrf": "true",
                    Authorization: authorization,
                },
                body: JSON.stringify({
                    input: text,
                    agent_id: mappedAgentId,
                    ...(conversationId ? { conversation_id: conversationId } : {}),
                }),
                cache: "no-store",
                signal: abortController.signal,
            })
        } finally {
            // Do not clear the timeout here; we want it to cover the entire SSE read as well.
        }

        span.setAttribute("http.status_code", response.status)

        if (!response.ok) {
            const details = await response.text()
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: `Agent Builder mirror failed with status ${response.status}`,
            })
            span.end()
            return NextResponse.json(
                {
                    success: false,
                    status: "failed",
                    conversationId: conversationId || null,
                    agentId: mappedAgentId,
                    mappedFromRealtimeAgent: mappedFromRealtimeAgent || null,
                    error: details,
                },
                { status: response.status },
            )
        }

        let mirroredConversationId = conversationId || null
        let persisted = false
        try {
            if (response.body) {
                const sseResult = await readConversationResultFromSse(response.body)
                mirroredConversationId = sseResult.conversationId || mirroredConversationId
                persisted = sseResult.persisted
            }
        } finally {
            clearTimeout(timeoutId)
        }

        span.setStatus({ code: SpanStatusCode.OK })
        if (mirroredConversationId) {
            span.setAttribute("gen_ai.conversation.id", mirroredConversationId)
        }
        span.end()

        return NextResponse.json({
            success: true,
            status: "mirrored",
            conversationId: mirroredConversationId,
            agentId: mappedAgentId,
            mappedFromRealtimeAgent: mappedFromRealtimeAgent || null,
            ...(persisted ? {} : { reason: "Mirror request completed, but persistence confirmation event was not observed." }),
        })
    } catch (error) {
        const isAbort = error instanceof Error && error.name === "AbortError"
        if (isAbort) {
            span.setStatus({ code: SpanStatusCode.OK, message: "Mirror request timed out before completion" })
            span.end()
            return NextResponse.json({
                success: true,
                status: "skipped",
                conversationId: null,
                agentId: process.env.AGENT_BUILDER_AGENT_ID?.trim() || DEFAULT_AGENT_ID,
                reason: "Mirror request timed out before Agent Builder completed.",
            })
        }

        const message = error instanceof Error ? error.message : "Failed to mirror Agent Builder turn"
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        if (error instanceof Error) {
            span.recordException(error)
        }
        span.end()
        return NextResponse.json(
            {
                success: false,
                status: "failed",
                conversationId: null,
                agentId: process.env.AGENT_BUILDER_AGENT_ID?.trim() || DEFAULT_AGENT_ID,
                error: message,
            },
            { status: 500 },
        )
    }
}

