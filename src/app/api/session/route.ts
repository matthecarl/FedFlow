import { NextResponse } from "next/server"
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api"
// Define the attributes locally to avoid import issues
const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name"
const ATTR_GEN_AI_SYSTEM = "gen_ai.system"
const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model"
const unavailable = "OpenAI Realtime is temporarily unavailable."
const headers = { "Cache-Control": "private, no-store, max-age=0" }

// Get a tracer instance
const tracer = trace.getTracer("openai-realtime-server")

export async function POST(request: Request) {
    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini"
    if (!process.env.OPENAI_API_KEY) {
        return NextResponse.json({ error: "OpenAI Realtime is not configured." }, { status: 503, headers })
    }
    // Create a span for the session creation
    const span = tracer.startSpan("openai.realtime.session.create", {
        kind: SpanKind.CLIENT,
        attributes: {
            [ATTR_GEN_AI_OPERATION_NAME]: "session_create",
            [ATTR_GEN_AI_SYSTEM]: "openai",
            [ATTR_GEN_AI_REQUEST_MODEL]: model,
            "http.method": "POST",
            "http.url": "https://api.openai.com/v1/realtime/client_secrets",
        },
    })

    try {
        const response = await context.with(trace.setSpan(context.active(), span), async () => {
            return fetch("https://api.openai.com/v1/realtime/client_secrets", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
                signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
                cache: "no-store",
                body: JSON.stringify({
                    expires_after: { anchor: "created_at", seconds: 60 },
                    session: {
                        type: "realtime",
                        model,
                        // Keep inference client-controlled from the initial SDP
                        // exchange, before the selected agent configuration arrives.
                        audio: { input: { turn_detection: null }, output: { voice: "echo" } },
                    },
                }),
            })
        })

        // Add response code to span
        span.setAttribute("http.status_code", response.status)

        if (!response.ok) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "OpenAI Realtime rejected session creation." })
            return NextResponse.json({ error: unavailable }, { status: response.status === 429 ? 429 : 502, headers })
        }
        const data = await response.json().catch(() => null)
        if (typeof data?.value !== "string" || !data.value.trim() || !Number.isSafeInteger(data.expires_at)) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "OpenAI Realtime returned an invalid credential." })
            return NextResponse.json({ error: unavailable }, { status: 502, headers })
        }
        span.setAttribute("genai.session.token_available", true)
        return NextResponse.json({ value: data.value, expires_at: data.expires_at, model }, { headers })
    } catch {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "OpenAI Realtime session request failed." })
        return NextResponse.json({ error: unavailable }, { status: 502, headers })
    } finally {
        span.end()
    }
}
