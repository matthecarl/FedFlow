/* global require, Request, Response */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

const { ATTR_GEN_AI_SYSTEM, ATTR_GEN_AI_RESPONSE_MODEL, ATTR_GEN_AI_TRANSCRIPT_FULL, METRIC_GEN_AI_CLIENT_TOKEN_USAGE } =
    load("src/app/lib/semconv.ts")

function telemetryFixture(env = {}) {
    const spans = []
    const metrics = []
    const route = load("src/app/api/telemetry/route.ts", {
        env,
        dependencies: {
            "@/app/lib/telemetry-safety": load("src/app/lib/telemetry-safety.ts"),
            "@/app/lib/voice-routes": load("src/app/lib/voice-routes.ts"),
            "@/app/lib/semconv": load("src/app/lib/semconv.ts"),
            "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
            perf_hooks: require("node:perf_hooks"),
            "@opentelemetry/api": {
                SpanKind: { SERVER: 1 },
                SpanStatusCode: { ERROR: 2 },
                context: { active: () => ({}), with: (_context, fn) => fn() },
                propagation: { extract: () => ({}) },
                trace: {
                    setSpan: () => ({}),
                    getTracer: () => ({
                        startSpan: (name, options) => {
                            const attributes = { ...options.attributes }
                            return {
                                setAttribute: (key, value) => { attributes[key] = value },
                                setStatus() {},
                                end: () => spans.push({ name, attributes }),
                            }
                        },
                    }),
                },
                metrics: { getMeter: () => ({ createHistogram: (name) => ({
                    record: (value, attributes) => metrics.push({ name, value, attributes }),
                }) }) },
            },
        },
    })
    const post = (payload) => route.POST(new Request("https://example.test/api/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    }))
    return { post, spans, metrics }
}

test("Gateway metrics and spans use the allowlisted model's actual provider", async () => {
    const { post, spans, metrics } = telemetryFixture()
    const model = "elevenlabs/eleven-realtime-v1-max"
    const response = await post({
        eventType: "token_usage",
        eventData: {
            inputTokens: 4,
            model,
            provider: "spoofed-provider",
            attributes: {
                [ATTR_GEN_AI_SYSTEM]: "spoofed-provider",
                [ATTR_GEN_AI_RESPONSE_MODEL]: "arbitrary-model",
                "gen_ai.provider.name": "spoofed-provider",
            },
        },
    })
    assert.equal(response.status, 200)
    const span = spans.find(({ name }) => name === "gen_ai.realtime.token_usage")
    assert.equal(span.attributes[ATTR_GEN_AI_SYSTEM], "elevenlabs")
    assert.equal(span.attributes[ATTR_GEN_AI_RESPONSE_MODEL], model)
    assert.equal(span.attributes["gen_ai.provider.name"], undefined)
    assert.equal(metrics.find(({ name }) => name === METRIC_GEN_AI_CLIENT_TOKEN_USAGE).value, 4)
    for (const metric of metrics) {
        assert.equal(metric.attributes[ATTR_GEN_AI_SYSTEM], "elevenlabs")
        assert.equal(metric.attributes[ATTR_GEN_AI_RESPONSE_MODEL], model)
    }
})

test("a mixed batch preserves per-event provider, default OpenAI, and transcript capture", async () => {
    const direct = "gpt-realtime-configured-fixture"
    const gateway = "spacexai/grok-voice-3.0"
    const { post, spans, metrics } = telemetryFixture({
        OPENAI_REALTIME_MODEL: direct,
        TELEMETRY_CAPTURE_FULL_CONTENT: "true",
    })
    const reply = await post([
        { eventType: "user_transcript", eventData: { model: gateway, transcript: "Synthetic caller text." } },
        { eventType: "token_usage", eventData: { model: direct, inputTokens: 6 } },
        { eventType: "session.created", eventData: { model: "arbitrary-model", provider: "arbitrary-provider" } },
    ])
    assert.equal(reply.status, 200)
    const transcript = spans.find(({ name }) => name === "gen_ai.realtime.user_transcript").attributes
    assert.equal(transcript[ATTR_GEN_AI_SYSTEM], "xai")
    assert.equal(transcript[ATTR_GEN_AI_RESPONSE_MODEL], gateway)
    assert.equal(transcript[ATTR_GEN_AI_TRANSCRIPT_FULL], "Synthetic caller text.")
    const oldEvent = spans.find(({ name }) => name === "gen_ai.realtime.token_usage").attributes
    assert.equal(oldEvent[ATTR_GEN_AI_SYSTEM], "openai")
    assert.equal(oldEvent[ATTR_GEN_AI_RESPONSE_MODEL], direct)
    const unknown = spans.find(({ name }) => name === "gen_ai.realtime.session.created").attributes
    assert.equal(unknown[ATTR_GEN_AI_SYSTEM], "openai")
    assert.equal(unknown[ATTR_GEN_AI_RESPONSE_MODEL], undefined)
    assert.equal(spans.find(({ name }) => name === "gen_ai.realtime.batch").attributes[ATTR_GEN_AI_SYSTEM], undefined)
    const tokenMetric = metrics.find(({ name }) => name === METRIC_GEN_AI_CLIENT_TOKEN_USAGE)
    assert.equal(tokenMetric.attributes[ATTR_GEN_AI_SYSTEM], "openai")
    assert.equal(tokenMetric.attributes[ATTR_GEN_AI_RESPONSE_MODEL], direct)
})
