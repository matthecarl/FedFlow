/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

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
