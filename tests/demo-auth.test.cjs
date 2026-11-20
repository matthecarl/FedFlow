/* global require, Buffer */
const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const next = require("next/server")
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server")
const load = require("./helpers/load-typescript.cjs")

const password = "test-only-strong-password:with-colon"
const authorization = (value = `demo:${password}`) => `Basic ${Buffer.from(value).toString("base64")}`
const request = (path = "/", headers = {}, method = "GET") =>
    new next.NextRequest(`https://demo.example${path}`, { headers, method })
const gate = (env = { DEMO_PASSWORD: password }) =>
    load("src/proxy.ts", { env, dependencies: { "node:crypto": crypto, "next/server": next } })

function assertPrivate(response) {
    assert.match(response.headers.get("cache-control"), /private.*no-store/)
    assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store")
    assert.equal(response.headers.get("cdn-cache-control"), "no-store")
}

test("demo gate fails closed when password is absent, empty, whitespace, or weak", () => {
    for (const value of [undefined, "", " ".repeat(32), "short-password"]) {
        const response = gate({ DEMO_PASSWORD: value }).proxy(request("/api/session", {}, "POST"))
        assert.equal(response.status, 503)
        assertPrivate(response)
        assert.equal(response.headers.get("x-middleware-next"), null)
    }
})

test("missing, malformed, incorrect credentials cannot access pages or APIs", () => {
    const { proxy } = gate()
    for (const value of ["", "Bearer anything", "Basic !!!", "Basic ", authorization("demo:wrong"), authorization(`admin:${password}`), authorization(`demo:${password}extra`)]) {
        for (const path of ["/", "/api/session", "/api/elasticsearch?q=test", "/api/support/handoffs"]) {
            const response = proxy(request(path, { authorization: value }))
            assert.equal(response.status, 401)
            assert.match(response.headers.get("www-authenticate"), /^Basic realm="FedFlow demo"/)
            assertPrivate(response)
        }
    }
})

test("valid credentials proceed without forwarding the demo password to handlers", () => {
    const response = gate().proxy(request("/api/session", { authorization: authorization(), "x-request-id": "test-request", origin: "https://demo.example", "sec-fetch-site": "same-origin" }, "POST"))
    assert.equal(response.headers.get("x-middleware-next"), "1")
    assert.equal(response.headers.get("x-middleware-request-authorization"), null)
    assert.ok(!response.headers.get("x-middleware-override-headers").split(",").includes("authorization"))
    assert.equal(response.headers.get("x-middleware-request-x-request-id"), "test-request")
    assertPrivate(response)
    assert.ok(!JSON.stringify([...response.headers]).includes(password))
})

test("cached browser credentials cannot be used for cross-origin API GETs or writes", () => {
    const { proxy } = gate()
    for (const method of ["GET", "POST", "OPTIONS"]) {
        for (const extra of [{ origin: "https://attacker.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
            const response = proxy(request("/api/session", { authorization: authorization(), ...extra }, method))
            assert.equal(response.status, 403)
            assert.equal(response.headers.get("x-middleware-next"), null)
            assertPrivate(response)
        }
    }
})

test("preflight and internal-looking headers do not bypass credential checking", () => {
    const response = gate().proxy(request("/api/session", { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy", "x-middleware-prefetch": "1", "x-nextjs-data": "1" }, "OPTIONS"))
    assert.equal(response.status, 401)
})

test("the Next matcher protects API, data, static, image, and dotted paths", () => {
    const { config } = gate()
    for (const url of ["/", "/api/session", "/api/webrtc", "/api/elasticsearch?q=test", "/api/support/handoffs", "/_next/data/build/index.json", "/_next/static/chunks/app.js", "/_next/image?url=%2Fimage.png&w=100&q=75", "/favicon.ico", "/private.json", "/error-test", "/.well-known/workflow/v1/webhook/unused", "/.well-known/workflow/v1/flow-extra", "/foo/.well-known/workflow/v1/flow"]) {
        assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), true, url)
    }
    for (const url of ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/flow/?retry=1"]) {
        assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), false, url)
    }
})

test("only an explicit false disables the gate; absent or mistyped flags stay protected", () => {
    for (const value of [undefined, "true", "False", "0", ""]) {
        assert.equal(gate({ DEMO_PASSWORD_ENABLED: value }).proxy(request()).status, 503)
    }
    const { proxy } = gate({ DEMO_PASSWORD_ENABLED: "false" })
    for (const path of ["/", "/api/session", "/_next/static/chunks/app.js"]) {
        const response = proxy(request(path))
        assert.equal(response.headers.get("x-middleware-next"), "1")
        assert.equal(response.headers.get("www-authenticate"), null)
        assertPrivate(response)
    }
})

test("disabled password gate still blocks cross-origin API requests", () => {
    const { proxy } = gate({ DEMO_PASSWORD_ENABLED: "false" })
    for (const method of ["GET", "POST", "OPTIONS"]) {
        for (const headers of [{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }]) {
            const response = proxy(request("/api/session", headers, method))
            assert.equal(response.status, 403)
            assert.equal(response.headers.get("x-middleware-next"), null)
            assertPrivate(response)
        }
    }
    assert.equal(proxy(request("/api/session", { origin: "https://demo.example" }, "POST")).headers.get("x-middleware-next"), "1")
})

test("handoffs require demo access when the general password gate is disabled", () => {
    const { proxy } = gate({ DEMO_PASSWORD: password, DEMO_PASSWORD_ENABLED: "false" })
    for (const method of ["GET", "POST"]) {
        assert.equal(proxy(request("/api/support/handoffs", {}, method)).status, 401)
        assert.equal(proxy(request("/api/support/handoffs", { authorization: authorization(), origin: "https://other.example" }, method)).status, 403)
        assert.equal(proxy(request("/api/support/handoffs", { authorization: authorization() }, method)).headers.get("x-middleware-next"), "1")
    }
})

test("disabled password gate strips cached Authorization credentials before handlers", () => {
    const response = gate({ DEMO_PASSWORD_ENABLED: "false" }).proxy(request("/api/session", { authorization: authorization(), "x-request-id": "disabled-gate-check" }, "POST"))
    assert.equal(response.headers.get("x-middleware-next"), "1")
    assert.equal(response.headers.get("x-middleware-request-authorization"), null)
    assert.ok(!response.headers.get("x-middleware-override-headers").split(",").includes("authorization"))
    assert.equal(response.headers.get("x-middleware-request-x-request-id"), "disabled-gate-check")
    assert.ok(!JSON.stringify([...response.headers]).includes(password))
})
