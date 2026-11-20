import { sanitizeTelemetry } from "@/app/lib/telemetry-safety"
import { InvalidRequestError, readRequestObject } from "@/app/lib/agent-builder-kibana"
import { NextRequest, NextResponse } from "next/server"
import { Client } from "@elastic/elasticsearch"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { asOptionalNonEmptyString } from "@/app/lib/agent-builder-kibana"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const tracer = trace.getTracer("agent-builder-api")
const DEFAULT_AGENT_CHAT_INDEX = "agent-builder-chat-events-v1"

let cachedClient: Client | null = null

interface PersistRouteBody {
    conversationId?: unknown
    agentId?: unknown
    roundId?: unknown
    events?: unknown
}

interface EventRecordInput {
    eventType: string
    timestamp: string
    role?: string
    content?: string
    status?: string
    toolName?: string
    latencyMs?: number
    sourceBackend?: string
    mirrorStatus?: string
    mappedAgentId?: string
    realtimeAgentName?: string
    raw: Record<string, unknown>
}

function asOptionalString(value: unknown): string | undefined {
    return asOptionalNonEmptyString(value)
}

function asRequiredString(value: unknown): string | null {
    return asOptionalString(value) ?? null
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>
    }

    return undefined
}

function asOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }

    if (typeof value === "string") {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
            return parsed
        }
    }

    return undefined
}

function normalizeEventRecord(rawEvent: unknown): EventRecordInput | null {
    const event = asOptionalObject(rawEvent)
    if (!event) {
        return null
    }

    const eventType =
        asOptionalString(event.eventType) ||
        asOptionalString(event.event_type) ||
        asOptionalString(event.type) ||
        "unknown"
    const timestamp = asOptionalString(event.timestamp) || new Date().toISOString()
    const role = asOptionalString(event.role)
    const status = asOptionalString(event.status)
    const toolName = asOptionalString(event.toolName) || asOptionalString(event.tool_name)
    const content = asOptionalString(event.content)
    const latencyMs = asOptionalNumber(event.latencyMs) ?? asOptionalNumber(event.latency_ms)
    const sourceBackend = asOptionalString(event.sourceBackend) || asOptionalString(event.source_backend)
    const mirrorStatus = asOptionalString(event.mirrorStatus) || asOptionalString(event.mirror_status)
    const mappedAgentId = asOptionalString(event.mappedAgentId) || asOptionalString(event.mapped_agent_id)
    const realtimeAgentName = asOptionalString(event.realtimeAgentName) || asOptionalString(event.realtime_agent_name)
    const rawPayload = sanitizeTelemetry(
        asOptionalObject(event.raw) || event,
        process.env.TELEMETRY_CAPTURE_FULL_CONTENT === "true",
    ) as Record<string, unknown>

    return {
        eventType,
        timestamp,
        role,
        status,
        toolName,
        content,
        latencyMs,
        sourceBackend,
        mirrorStatus,
        mappedAgentId,
        realtimeAgentName,
        raw: rawPayload,
    }
}

function resolveElasticClient(): { client: Client; indexName: string } {
    const node = process.env.ELASTICSEARCH_CAPSTONE_URL?.trim()
    const apiKey = process.env.ELASTICSEARCH_LOGSAI_API_KEY?.trim()

    if (!node || !apiKey) {
        throw new Error(
            "Elasticsearch credentials are missing for Agent Builder event persistence. Set ELASTICSEARCH_CAPSTONE_URL and ELASTICSEARCH_LOGSAI_API_KEY.",
        )
    }

    if (!cachedClient) {
        cachedClient = new Client({
            node,
            requestTimeout: 10000,
            maxRetries: 0,
            auth: {
                apiKey,
            },
        })
    }

    return {
        client: cachedClient,
        indexName: process.env.AGENT_BUILDER_INDEX_NAME?.trim() || DEFAULT_AGENT_CHAT_INDEX,
    }
}

export async function POST(req: NextRequest) {
    const span = tracer.startSpan("agent_builder.events.persist", {
        kind: SpanKind.SERVER,
        attributes: {
            "gen_ai.system": "elastic_agent_builder",
            "gen_ai.operation.name": "persist_events",
            "http.method": "POST",
            "http.route": "/api/agent-builder/events",
        },
    })

    try {
        const body = (await readRequestObject(req)) as PersistRouteBody
        const conversationId = asRequiredString(body.conversationId)
        const agentId = asRequiredString(body.agentId)
        const roundId = asRequiredString(body.roundId)

        if (!conversationId || !agentId || !roundId) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Missing required metadata fields" })
            span.end()
            return NextResponse.json(
                {
                    error: "Missing required fields: conversationId, agentId, and roundId are all required.",
                },
                {
                    status: 400,
                },
            )
        }

        if (!Array.isArray(body.events)) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "events must be an array" })
            span.end()
            return NextResponse.json({ error: "Missing required `events` array." }, { status: 400 })
        }

        if (body.events.length > 100) throw new InvalidRequestError("At most 100 events are allowed per request.", 413)

        const normalizedEvents = body.events.map((event) => normalizeEventRecord(event)).filter((event) => !!event)

        if (normalizedEvents.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK })
            span.setAttribute("gen_ai.event.count", 0)
            span.end()
            return NextResponse.json({ accepted: 0, failed: 0 })
        }

        const { client, indexName } = resolveElasticClient()

        const operations: Array<Record<string, unknown>> = []

        normalizedEvents.forEach((event, sequence) => {
            if (!event) {
                return
            }

            const timestamp = new Date(event.timestamp)
            const normalizedTimestamp = Number.isNaN(timestamp.valueOf())
                ? new Date().toISOString()
                : timestamp.toISOString()

            operations.push({
                create: {
                    _index: indexName,
                },
            })

            operations.push({
                "@timestamp": normalizedTimestamp,
                app: "realtime-elastic",
                channel: "agent_builder_mirror",
                agent_id: agentId,
                conversation_id: conversationId,
                round_id: roundId,
                sequence,
                event_type: event.eventType,
                ...(event.role ? { role: event.role } : {}),
                ...(event.status ? { status: event.status } : {}),
                ...(event.toolName ? { tool_name: event.toolName } : {}),
                ...(event.sourceBackend ? { source_backend: event.sourceBackend } : {}),
                ...(event.mirrorStatus ? { mirror_status: event.mirrorStatus } : {}),
                ...(event.mappedAgentId ? { mapped_agent_id: event.mappedAgentId } : {}),
                ...(event.realtimeAgentName ? { realtime_agent_name: event.realtimeAgentName } : {}),
                ...(event.content && process.env.TELEMETRY_CAPTURE_FULL_CONTENT === "true"
                    ? { content: sanitizeTelemetry(event.content, true) }
                    : {}),
                ...(event.content ? { content_length: event.content.length } : {}),
                ...(typeof event.latencyMs === "number" ? { latency_ms: event.latencyMs } : {}),
                raw: event.raw,
            })
        })

        const bulkResponse = await client.bulk({
            operations,
        })

        const items = (bulkResponse as any).items as any[] | undefined
        const errors = Boolean((bulkResponse as any).errors)

        let failed = 0
        if (errors && Array.isArray(items)) {
            for (const item of items) {
                const entry = item?.create
                if (entry?.error) {
                    failed += 1
                }
            }
        }

        const accepted = normalizedEvents.length - failed

        span.setAttribute("gen_ai.event.count", normalizedEvents.length)
        span.setAttribute("gen_ai.event.failed", failed)
        span.setAttribute("gen_ai.event.accepted", accepted)
        span.setAttribute("gen_ai.conversation.id", conversationId)
        span.setAttribute("gen_ai.agent.id", agentId)

        if (failed > 0) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Some events failed to index" })
        } else {
            span.setStatus({ code: SpanStatusCode.OK })
        }

        span.end()
        return NextResponse.json({ accepted, failed }, { status: failed ? 502 : 200 })
    } catch (error) {
        const message = error instanceof InvalidRequestError ? error.message : "Event persistence is unavailable."
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        span.end()
        return NextResponse.json(
            { error: message },
            { status: error instanceof InvalidRequestError ? error.status : 503 },
        )
    }
}
