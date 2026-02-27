import { NextRequest, NextResponse } from "next/server"
import { Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
    asNonEmptyStringOrNull,
    resolveAuthorizationHeader,
    resolveConverseUrl,
    resolveMappedAgentId,
} from "@/app/lib/agent-builder-kibana"

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
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null

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
            upstreamReader = upstreamBody.getReader()

            try {
                while (true) {
                    const { done, value } = await upstreamReader.read()
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
            } finally {
                try {
                    upstreamReader?.releaseLock()
                } catch {
                    // ignore
                }
                upstreamReader = null
            }
        },
        cancel(reason) {
            span.setAttribute("agent_builder.stream.cancelled", true)
            if (reason) {
                span.setAttribute("agent_builder.stream.cancel_reason", String(reason))
            }

            // Stop upstream work if the downstream client disconnects early.
            try {
                void upstreamReader?.cancel()
            } catch {
                // ignore
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
        const input = asNonEmptyStringOrNull(body.input)
        const conversationId = asNonEmptyStringOrNull(body.conversationId) || asNonEmptyStringOrNull(body.conversation_id)
        const selectedRealtimeAgentName = asNonEmptyStringOrNull(body.selectedRealtimeAgentName)

        if (!input) {
            endSpan(span, SpanStatusCode.ERROR, "Missing input")
            return NextResponse.json({ error: "Missing required `input` string." }, { status: 400 })
        }

        if (input.length > MAX_INPUT_LENGTH) {
            endSpan(span, SpanStatusCode.ERROR, "Input too large")
            return NextResponse.json({ error: `Input exceeds ${MAX_INPUT_LENGTH} characters.` }, { status: 400 })
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
            endSpan(span, SpanStatusCode.ERROR, `Kibana request failed with status ${upstreamResponse.status}: ${responseText}`)

            return NextResponse.json(
                {
                    error: "Agent Builder request failed",
                    status: upstreamResponse.status,
                    details: responseText,
                },
                { status: upstreamResponse.status },
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

