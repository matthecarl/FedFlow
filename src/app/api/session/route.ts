import { NextResponse } from "next/server"
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api"
// Define the attributes locally to avoid import issues
const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name"
const ATTR_GEN_AI_SYSTEM = "gen_ai.system"
const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model"

// Get a tracer instance
const tracer = trace.getTracer("openai-realtime-server")

export async function POST() {
    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini"
    if (!process.env.OPENAI_API_KEY) {
        return NextResponse.json({ error: "OpenAI API key is not configured on the server." }, { status: 503 })
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
                signal: AbortSignal.timeout(15000),
                cache: "no-store",
                body: JSON.stringify({
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
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: `HTTP error ${response.status}: ${response.statusText}`,
            })
        }

        const data = await response.json()

        // Add session ID if available
        if (data?.value) {
            span.setAttribute("genai.session.token_available", true)
        }

        if (!response.ok) {
            return NextResponse.json({ error: data.error?.message || "OpenAI session creation failed." }, { status: response.status })
        }
        return NextResponse.json({ value: data.value, expires_at: data.expires_at, model }, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("Error in /session:", error)

        // Record error in span
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
        })

        if (error instanceof Error) {
            span.recordException(error)
        }

        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    } finally {
        span.end()
    }
}
