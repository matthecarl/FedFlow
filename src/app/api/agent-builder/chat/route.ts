import { InvalidRequestError, readRequestObject } from "@/app/lib/agent-builder-kibana"
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
        const body = (await readRequestObject(req)) as ChatRouteRequestBody
        const input = asNonEmptyStringOrNull(body.input)
        const conversationId =
            asNonEmptyStringOrNull(body.conversationId) || asNonEmptyStringOrNull(body.conversation_id)
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
                "x-elastic-internal-origin": "kibana",
                Accept: "text/event-stream",
                Authorization: authorization,
            },
            body: JSON.stringify({
                input,
                agent_id: agentId,
                ...(conversationId ? { conversation_id: conversationId } : {}),
            }),
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(120000)]),
            cache: "no-store",
            redirect: "error",
        })

        span.setAttribute("http.status_code", upstreamResponse.status)

        if (!upstreamResponse.ok) {
            await upstreamResponse.body?.cancel()
            endSpan(span, SpanStatusCode.ERROR, `Kibana request failed with status ${upstreamResponse.status}`)

            return NextResponse.json(
                {
                    error: "Agent Builder request failed",
                    status: upstreamResponse.status,
                },
                { status: upstreamResponse.status === 429 ? 429 : 502 },
            )
        }

        if (!upstreamResponse.headers.get("content-type")?.includes("text/event-stream")) {
            await upstreamResponse.body?.cancel()
            endSpan(span, SpanStatusCode.ERROR, "Unexpected upstream content type")
            return NextResponse.json({ error: "Agent Builder did not return an event stream." }, { status: 502 })
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
        const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        const message =
            error instanceof InvalidRequestError
                ? error.message
                : isTimeout
                  ? "Agent Builder request timed out."
                  : "Agent Builder is unavailable. Check its server configuration and credentials."
        endSpan(span, SpanStatusCode.ERROR, message)
        return NextResponse.json(
            { error: message },
            { status: error instanceof InvalidRequestError ? error.status : isTimeout ? 504 : 503 },
        )
    }
}
