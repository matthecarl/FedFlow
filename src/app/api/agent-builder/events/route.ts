import { NextRequest, NextResponse } from "next/server"
import { Client } from "@elastic/elasticsearch"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"

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
    if (typeof value !== "string") {
        return undefined
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
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
        asOptionalString(event.eventType) || asOptionalString(event.event_type) || asOptionalString(event.type) || "unknown"
    const timestamp = asOptionalString(event.timestamp) || new Date().toISOString()
    const role = asOptionalString(event.role)
    const status = asOptionalString(event.status)
    const toolName = asOptionalString(event.toolName) || asOptionalString(event.tool_name)
    const content = asOptionalString(event.content)
    const latencyMs = asOptionalNumber(event.latencyMs) || asOptionalNumber(event.latency_ms)
    const sourceBackend = asOptionalString(event.sourceBackend) || asOptionalString(event.source_backend)
    const mirrorStatus = asOptionalString(event.mirrorStatus) || asOptionalString(event.mirror_status)
    const mappedAgentId = asOptionalString(event.mappedAgentId) || asOptionalString(event.mapped_agent_id)
    const realtimeAgentName = asOptionalString(event.realtimeAgentName) || asOptionalString(event.realtime_agent_name)
    const rawPayload = asOptionalObject(event.raw) || event

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

async function ensureIndexExists(client: Client, indexName: string): Promise<void> {
    const properties: Record<string, any> = {
        "@timestamp": { type: "date" },
        app: { type: "keyword" },
        channel: { type: "keyword" },
        agent_id: { type: "keyword" },
        conversation_id: { type: "keyword" },
        round_id: { type: "keyword" },
        sequence: { type: "integer" },
        event_type: { type: "keyword" },
        role: { type: "keyword" },
        status: { type: "keyword" },
        tool_name: { type: "keyword" },
        source_backend: { type: "keyword" },
        mirror_status: { type: "keyword" },
        mapped_agent_id: { type: "keyword" },
        realtime_agent_name: { type: "keyword" },
        content: { type: "text" },
        content_length: { type: "integer" },
        latency_ms: { type: "long" },
        raw: { type: "object", enabled: true },
    }

    const existsResponse = await client.indices.exists({ index: indexName })
    const exists =
        typeof existsResponse === "boolean"
            ? existsResponse
            : Boolean((existsResponse as { body?: boolean }).body)

    try {
        if (!exists) {
            await client.indices.create({
                index: indexName,
                mappings: { properties },
            })
            return
        }

        await client.indices.putMapping({
            index: indexName,
            properties,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes("resource_already_exists_exception")) {
            throw error
        }
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
        const body = (await req.json()) as PersistRouteBody
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

        const normalizedEvents = body.events.map((event) => normalizeEventRecord(event)).filter((event) => !!event)

        if (normalizedEvents.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK })
            span.setAttribute("gen_ai.event.count", 0)
            span.end()
            return NextResponse.json({ accepted: 0, failed: 0 })
        }

        const { client, indexName } = resolveElasticClient()
        await ensureIndexExists(client, indexName)

        const operations: Array<Record<string, unknown>> = []

        normalizedEvents.forEach((event, sequence) => {
            if (!event) {
                return
            }

            const timestamp = new Date(event.timestamp)
            const normalizedTimestamp = Number.isNaN(timestamp.valueOf()) ? new Date().toISOString() : timestamp.toISOString()

            operations.push({
                index: {
                    _index: indexName,
                },
            })

            operations.push({
                "@timestamp": normalizedTimestamp,
                app: "openai-realtime-agents",
                channel: "agent_builder_chat",
                agent_id: agentId,
                conversation_id: conversationId,
                round_id: roundId,
                sequence,
                event_type: event.eventType,
                role: event.role,
                status: event.status,
                tool_name: event.toolName,
                source_backend: event.sourceBackend,
                mirror_status: event.mirrorStatus,
                mapped_agent_id: event.mappedAgentId,
                realtime_agent_name: event.realtimeAgentName,
                content: event.content,
                content_length: event.content?.length ?? 0,
                latency_ms: event.latencyMs,
                raw: event.raw,
            })
        })

        const bulkResponse = await client.bulk({
            refresh: false,
            operations,
        })

        const hasErrors =
            typeof (bulkResponse as { errors?: boolean }).errors === "boolean"
                ? Boolean((bulkResponse as { errors?: boolean }).errors)
                : Boolean((bulkResponse as { body?: { errors?: boolean } }).body?.errors)

        const items =
            (bulkResponse as { items?: Array<Record<string, { error?: unknown }>> }).items ||
            (bulkResponse as { body?: { items?: Array<Record<string, { error?: unknown }>> } }).body?.items ||
            []

        const failed = hasErrors
            ? items.reduce((count, item) => {
                  const action = Object.values(item)[0]
                  return action?.error ? count + 1 : count
              }, 0)
            : 0

        const accepted = normalizedEvents.length - failed

        span.setAttribute("gen_ai.event.count", normalizedEvents.length)
        span.setAttribute("gen_ai.event.accepted", accepted)
        span.setAttribute("gen_ai.event.failed", failed)
        span.setAttribute("gen_ai.conversation.id", conversationId)
        span.setAttribute("gen_ai.agent.id", agentId)

        span.setStatus({ code: failed > 0 ? SpanStatusCode.ERROR : SpanStatusCode.OK })
        span.end()

        return NextResponse.json({ accepted, failed })
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to persist Agent Builder events"
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        if (error instanceof Error) {
            span.recordException(error)
        }
        span.end()
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
