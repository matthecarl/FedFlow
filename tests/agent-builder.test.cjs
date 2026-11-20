/* global require, Response, Request, AbortSignal */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")
const next = { NextResponse: { json: (body, options) => Response.json(body, options) } }
const tracing = {
    SpanKind: {},
    SpanStatusCode: {},
    trace: {
        getTracer: () => ({ startSpan: () => ({ setStatus() {}, setAttribute() {}, end() {}, recordException() {} }) }),
    },
}
const sse = load("src/app/lib/agent-builder-sse.ts")
const config = { KIBANA_URL: "https://example.test", KIBANA_API_KEY: "test-only" }

function moduleWithFetch(file, fetch) {
    return load(file, {
        env: config,
        dependencies: {
            "next/server": next,
            "@opentelemetry/api": tracing,
            "@/app/lib/agent-builder-kibana": load("src/app/lib/agent-builder-kibana.ts", { env: config }),
            "@/app/lib/agent-builder-sse": sse,
        },
        globals: { fetch },
    })
}
const post = (body) => new Request("https://example.test/api", { method: "POST", body: JSON.stringify(body) })

test("Kibana requires explicit credentials rather than reusing indexing keys", () => {
    const api = load("src/app/lib/agent-builder-kibana.ts", { env: { ELASTICSEARCH_LOGSAI_API_KEY: "wrong-scope" } })
    assert.throws(() => api.resolveAuthorizationHeader(), /not configured/)
})

test("chat hides upstream error body and sends required streaming headers", async () => {
    let sent
    const api = moduleWithFetch("src/app/api/agent-builder/chat/route.ts", async (url, options) => {
        sent = options
        return new Response("private server credentials", { status: 401 })
    })
    const response = await api.POST(post({ input: "hello" }))
    assert.equal(response.status, 502)
    assert.ok(!(await response.text()).includes("private server credentials"))
    assert.equal(sent.headers["x-elastic-internal-origin"], "kibana")
    assert.equal(sent.headers["kbn-xsrf"], "true")
    assert.equal(sent.headers.Accept, "text/event-stream")
    assert.equal(sent.redirect, "error")
    assert.ok(sent.signal instanceof AbortSignal)
})

test("null chat input fails before any network call", async () => {
    const api = moduleWithFetch("src/app/api/agent-builder/chat/route.ts", () => {
        throw new Error("should not call")
    })
    assert.equal((await api.POST(post(null))).status, 400)
})

test("mirror requires a persisted conversation event, not merely round completion", async () => {
    for (const [event, expected] of [
        ["round_complete", false],
        ["conversation_created", true],
        ["conversation_updated", true],
    ]) {
        const api = moduleWithFetch(
            "src/app/api/agent-builder/mirror/route.ts",
            async () =>
                new Response(`event: ${event}\ndata: {"data":{"conversation_id":"test-id"}}\n\n`, {
                    headers: { "content-type": "text/event-stream" },
                }),
        )
        const response = await api.POST(post({ text: "hello", role: "user" }))
        assert.equal((await response.json()).success, expected)
    }
})

test("telemetry redacts nested credentials and makes transcript capture opt-in", () => {
    const api = load("src/app/lib/telemetry-safety.ts")
    const value = {
        totalTokens: 100,
        content: "private transcript",
        raw: {
            client_secret: { value: "key" },
            Authorization: "Bearer test",
            token_usage: { input_tokens: 5 },
            message: "secret conversation",
            status: "uses sk-abcdefghijklmno",
        },
    }
    const sanitized = JSON.parse(JSON.stringify(api.sanitizeTelemetry(value)))
    assert.equal(sanitized.content, undefined)
    assert.equal(sanitized.raw.client_secret, undefined)
    assert.equal(sanitized.raw.Authorization, undefined)
    assert.equal(sanitized.raw.message, undefined)
    assert.equal(sanitized.raw.token_usage.input_tokens, 5)
    assert.equal(sanitized.raw.status, "uses [redacted]")
    assert.equal(api.sanitizeTelemetry(value, true).content, "private transcript")
    assert.equal(api.sanitizeTelemetry(value, true).raw.client_secret, undefined)
})

test("event ingestion appends with create_doc scope and reports failed bulk items", async () => {
    let operations
    const safety = load("src/app/lib/telemetry-safety.ts")
    const api = load("src/app/api/agent-builder/events/route.ts", {
        env: { ELASTICSEARCH_CAPSTONE_URL: "https://example.test", ELASTICSEARCH_LOGSAI_API_KEY: "test-only" },
        dependencies: {
            "next/server": next,
            "@opentelemetry/api": tracing,
            "@/app/lib/telemetry-safety": safety,
            "@/app/lib/agent-builder-kibana": load("src/app/lib/agent-builder-kibana.ts"),
            "@elastic/elasticsearch": {
                Client: class {
                    async bulk(body) {
                        operations = body.operations
                        return { errors: true, items: [{ create: { error: { type: "test" } } }] }
                    }
                },
            },
        },
    })
    const response = await api.POST(
        post({
            conversationId: "conversation",
            agentId: "agent",
            roundId: "round",
            events: [{ type: "message", content: "private", raw: { client_secret: "key" } }],
        }),
    )
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { accepted: 0, failed: 1 })
    assert.equal(operations[0].create._index, "agent-builder-chat-events-v1")
    assert.equal(operations[1].content, undefined)
    assert.equal(operations[1].content_length, 7)
    assert.equal(operations[1].raw.client_secret, undefined)
})

test("WebRTC telemetry imports without credentials and validates before sanitized append-only indexing", async () => {
    const documents = []
    const dependencies = {
        "next/server": next,
        "@/app/lib/agent-builder-kibana": load("src/app/lib/agent-builder-kibana.ts"),
        "@/app/lib/telemetry-safety": load("src/app/lib/telemetry-safety.ts"),
        "@elastic/elasticsearch": {
            Client: class {
                async index(body) {
                    documents.push(body)
                    return {}
                }
            },
        },
    }
    const unconfigured = load("src/app/api/webrtc/route.ts", { dependencies })
    assert.equal((await unconfigured.POST(post({ stats: [] }))).status, 503)
    const api = load("src/app/api/webrtc/route.ts", {
        dependencies,
        env: { ELASTICSEARCH_CAPSTONE_URL: "https://example.test", ELASTICSEARCH_LOGSAI_API_KEY: "test-only" },
    })
    assert.equal((await api.POST(post({ extra: "a".repeat(64001) }))).status, 413)
    assert.equal(documents.length, 0)
    assert.equal(
        (
            await api.POST(
                post({
                    stats: [{ jitter: 0.1 }],
                    api_key: "secret",
                    transcript: "private",
                    raw: { client_secret: "secret" },
                }),
            )
        ).status,
        200,
    )
    assert.equal(documents[0].op_type, "create")
    assert.equal(documents[0].index, "webrtc-stats")
    assert.equal(documents[0].document.api_key, undefined)
    assert.equal(documents[0].document.transcript, undefined)
    assert.equal(documents[0].document.raw.client_secret, undefined)
    assert.equal(documents[0].document.stats[0].jitter, 0.1)
})
