/* global require, Response, Request */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")
const next = { NextResponse: { json: (body, options) => Response.json(body, options) } }
const post = (body) => new Request("https://example.test/api/webrtc", { method: "POST", body: JSON.stringify(body) })

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

test("WebRTC telemetry validates input and uses only the logging key for sanitized append-only indexing", async () => {
    const documents = []
    const clientOptions = []
    const dependencies = {
        "next/server": next,
        "@/app/lib/request-json": load("src/app/lib/request-json.ts"),
        "@/app/lib/telemetry-safety": load("src/app/lib/telemetry-safety.ts"),
        "@elastic/elasticsearch": {
            Client: class {
                constructor(options) {
                    clientOptions.push(options)
                }
                async index(body) {
                    documents.push(body)
                    return {}
                }
            },
        },
    }
    const unconfigured = load("src/app/api/webrtc/route.ts", { dependencies })
    assert.equal((await unconfigured.POST(post({ stats: [] }))).status, 503)
    const elasticUrl = "https://example.test"
    const searchOnly = load("src/app/api/webrtc/route.ts", {
        dependencies,
        env: { ELASTICSEARCH_CAPSTONE_URL: elasticUrl, ELASTICSEARCH_CAPSTONE_API_KEY: "fixture-search-only" },
    })
    assert.equal((await searchOnly.POST(post({ stats: [] }))).status, 503)
    const api = load("src/app/api/webrtc/route.ts", {
        dependencies,
        env: {
            ELASTICSEARCH_CAPSTONE_URL: elasticUrl,
            ELASTICSEARCH_CAPSTONE_API_KEY: "fixture-search-only",
            ELASTICSEARCH_LOGSAI_API_KEY: "fixture-log-write",
        },
    })
    assert.equal((await api.POST(post({ extra: "a".repeat(64001) }))).status, 413)
    assert.equal((await api.POST(post(null))).status, 400)
    assert.equal(documents.length, 0)
    assert.equal(clientOptions.length, 0)
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
    assert.equal(clientOptions[0].auth.apiKey, "fixture-log-write")
    assert.equal(documents[0].op_type, "create")
    assert.equal(documents[0].index, "webrtc-stats")
    assert.equal(documents[0].document.api_key, undefined)
    assert.equal(documents[0].document.transcript, undefined)
    assert.equal(documents[0].document.raw.client_secret, undefined)
    assert.equal(documents[0].document.stats[0].jitter, 0.1)
})
