import { NextRequest, NextResponse } from "next/server"
import { Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const tracer = trace.getTracer("agent-builder-api")
const MAX_INPUT_LENGTH = 8000

interface ChatRouteRequestBody {
    input?: unknown
    conversationId?: unknown
    conversation_id?: unknown
    selectedRealtimeAgentName?: unknown
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function resolveAuthorizationHeader(): string {
    const apiKey = process.env.KIBANA_API_KEY?.trim()
    if (apiKey) {
        return apiKey.startsWith("ApiKey ") ? apiKey : `ApiKey ${apiKey}`
    }

    const legacyApiKey = process.env.ELASTICSEARCH_LOGSAI_API_KEY?.trim() || process.env.ELASTICSEARCH_CAPSTONE_API_KEY?.trim()
    if (legacyApiKey) {
        return legacyApiKey.startsWith("ApiKey ") ? legacyApiKey : `ApiKey ${legacyApiKey}`
    }

    const username = process.env.KIBANA_USERNAME?.trim()
    const password = process.env.KIBANA_PASSWORD?.trim()

    if (username && password) {
        const encodedCredentials = Buffer.from(`${username}:${password}`).toString("base64")
        return `Basic ${encodedCredentials}`
    }

    throw new Error("Kibana authentication is not configured. Set KIBANA_API_KEY or KIBANA_USERNAME/KIBANA_PASSWORD.")
}

function deriveKibanaUrlFromElasticsearchUrl(): string | null {
    const elasticsearchUrl = process.env.ELASTICSEARCH_CAPSTONE_URL?.trim()
    if (!elasticsearchUrl) {
        return null
    }

    try {
        const parsedUrl = new URL(elasticsearchUrl)
        if (!parsedUrl.hostname.includes(".es.")) {
            return null
        }

        parsedUrl.hostname = parsedUrl.hostname.replace(".es.", ".kb.")
        return parsedUrl.origin
    } catch {
        return null
    }
}

function resolveConverseUrl(): string {
    const kibanaUrl = process.env.KIBANA_URL?.trim() || deriveKibanaUrlFromElasticsearchUrl()
    if (!kibanaUrl) {
        throw new Error(
            "Kibana URL is not configured. Set KIBANA_URL, or ELASTICSEARCH_CAPSTONE_URL with an .es. hostname for auto-derivation.",
        )
    }

    const normalizedBaseUrl = kibanaUrl.replace(/\/+$/, "")
    const spaceId = process.env.KIBANA_SPACE_ID?.trim()

    if (spaceId) {
        return `${normalizedBaseUrl}/s/${spaceId}/api/agent_builder/converse/async`
    }

    return `${normalizedBaseUrl}/api/agent_builder/converse/async`
}

function resolveMappedAgentId(realtimeAgentName?: string): { mappedAgentId: string; mappedFromRealtimeAgent?: string } {
    const defaultAgentId = process.env.AGENT_BUILDER_AGENT_ID?.trim() || "elastic-ai-agent"

    if (!realtimeAgentName) {
        return { mappedAgentId: defaultAgentId }
    }

    const mapString = process.env.AGENT_BUILDER_AGENT_MAP_JSON?.trim()
    if (!mapString) {
        return {
            mappedAgentId: defaultAgentId,
            mappedFromRealtimeAgent: realtimeAgentName,
        }
    }

    try {
        const parsedMap = JSON.parse(mapString)
        if (!parsedMap || typeof parsedMap !== "object" || Array.isArray(parsedMap)) {
            return {
                mappedAgentId: defaultAgentId,
                mappedFromRealtimeAgent: realtimeAgentName,
            }
        }

        const directMatch = (parsedMap as Record<string, unknown>)[realtimeAgentName]
        if (typeof directMatch === "string" && directMatch.trim().length > 0) {
            return {
                mappedAgentId: directMatch.trim(),
                mappedFromRealtimeAgent: realtimeAgentName,
            }
        }

        const normalizedName = realtimeAgentName.toLowerCase()
        for (const [mapKey, mapValue] of Object.entries(parsedMap as Record<string, unknown>)) {
            if (mapKey.toLowerCase() === normalizedName && typeof mapValue === "string" && mapValue.trim()) {
                return {
                    mappedAgentId: mapValue.trim(),
                    mappedFromRealtimeAgent: realtimeAgentName,
                }
            }
        }
    } catch {
        // Fall through to default agent id.
    }

    return {
        mappedAgentId: defaultAgentId,
        mappedFromRealtimeAgent: realtimeAgentName,
    }
}

function endSpan(span: Span, statusCode: SpanStatusCode, statusMessage?: string, error?: unknown) {
    span.setStatus({
        code: statusCode,
        ...(statusMessage ? { message: statusMessage } : {}),
    })

    if (error instanceof Error) {
        span.recordException(error)
    }

    span.end()
}

function createInstrumentedSseStream(upstreamBody: ReadableStream<Uint8Array>, span: Span): ReadableStream<Uint8Array> {
    let bytesTransferred = 0
    let hasEnded = false

    const endSpanOnce = (statusCode: SpanStatusCode, statusMessage?: string, error?: unknown) => {
        if (hasEnded) {
            return
        }

        hasEnded = true
        span.setAttribute("agent_builder.stream.bytes", bytesTransferred)
        endSpan(span, statusCode, statusMessage, error)
    }

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            const reader = upstreamBody.getReader()

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) {
                        break
                    }

                    if (!value) {
                        continue
                    }

                    bytesTransferred += value.byteLength
                    controller.enqueue(value)
                }

                controller.close()
                endSpanOnce(SpanStatusCode.OK)
            } catch (streamError) {
                controller.error(streamError)
                endSpanOnce(
                    SpanStatusCode.ERROR,
                    streamError instanceof Error ? streamError.message : "Agent Builder stream forwarding failed",
                    streamError,
                )
            }
        },
        cancel(reason) {
            span.setAttribute("agent_builder.stream.cancelled", true)
            if (reason) {
                span.setAttribute("agent_builder.stream.cancel_reason", String(reason))
            }
            endSpanOnce(SpanStatusCode.OK, "Client cancelled stream")
        },
    })
}

export async function POST(req: NextRequest) {
    const span = tracer.startSpan("agent_builder.chat.proxy", {
        kind: SpanKind.SERVER,
        attributes: {
            "gen_ai.system": "elastic_agent_builder",
            "gen_ai.operation.name": "converse_async_proxy",
            "http.method": "POST",
            "http.route": "/api/agent-builder/chat",
        },
    })

    try {
        const body = (await req.json()) as ChatRouteRequestBody
        const input = asNonEmptyString(body.input)
        const conversationId = asNonEmptyString(body.conversationId) || asNonEmptyString(body.conversation_id)
        const selectedRealtimeAgentName = asNonEmptyString(body.selectedRealtimeAgentName)

        if (!input) {
            endSpan(span, SpanStatusCode.ERROR, "Missing input")
            return NextResponse.json({ error: "Missing required `input` string." }, { status: 400 })
        }

        if (input.length > MAX_INPUT_LENGTH) {
            endSpan(span, SpanStatusCode.ERROR, "Input too large")
            return NextResponse.json(
                { error: `Input exceeds ${MAX_INPUT_LENGTH} characters.` },
                {
                    status: 400,
                },
            )
        }

        const converseUrl = resolveConverseUrl()
        const authorization = resolveAuthorizationHeader()
        const { mappedAgentId, mappedFromRealtimeAgent } = resolveMappedAgentId(selectedRealtimeAgentName || undefined)
        const agentId = mappedAgentId

        span.setAttribute("gen_ai.agent.id", agentId)
        if (conversationId) {
            span.setAttribute("gen_ai.conversation.id", conversationId)
        }
        if (mappedFromRealtimeAgent) {
            span.setAttribute("gen_ai.realtime.agent_name", mappedFromRealtimeAgent)
        }

        const upstreamResponse = await fetch(converseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "kbn-xsrf": "true",
                Authorization: authorization,
            },
            body: JSON.stringify({
                input,
                agent_id: agentId,
                ...(conversationId ? { conversation_id: conversationId } : {}),
            }),
            cache: "no-store",
        })

        span.setAttribute("http.status_code", upstreamResponse.status)

        if (!upstreamResponse.ok) {
            const responseText = await upstreamResponse.text()
            endSpan(
                span,
                SpanStatusCode.ERROR,
                `Kibana request failed with status ${upstreamResponse.status}: ${responseText}`,
            )

            return NextResponse.json(
                {
                    error: "Agent Builder request failed",
                    status: upstreamResponse.status,
                    details: responseText,
                },
                {
                    status: upstreamResponse.status,
                },
            )
        }

        if (!upstreamResponse.body) {
            endSpan(span, SpanStatusCode.ERROR, "Kibana response body was empty")
            return NextResponse.json({ error: "Agent Builder stream body was empty." }, { status: 502 })
        }

        const passthroughStream = createInstrumentedSseStream(upstreamResponse.body, span)

        const responseHeaders = new Headers()
        responseHeaders.set("Content-Type", upstreamResponse.headers.get("content-type") || "text/event-stream")
        responseHeaders.set("Cache-Control", "no-cache, no-transform")
        responseHeaders.set("Connection", "keep-alive")
        responseHeaders.set("x-agent-builder-agent-id", agentId)

        return new Response(passthroughStream, {
            status: upstreamResponse.status,
            headers: responseHeaders,
        })
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error while proxying Agent Builder stream"
        endSpan(span, SpanStatusCode.ERROR, errorMessage, error)
        return NextResponse.json({ error: errorMessage }, { status: 500 })
    }
}
