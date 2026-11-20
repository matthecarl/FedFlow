/* global require, Request */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

const registry = load("src/app/lib/voice-routes.ts")
const url = "https://demo.example/api/session/gateway"
const gatewaySocket = (model) => `wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=${encodeURIComponent(model)}`
const makeRequest = (query, body) => new Request(`${url}${query}`, {
    method: "POST",
    ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
})

const fixtures = {
    IRS: ["elevenlabs/eleven-realtime-v1-max", "ElevenLabs"],
    VA: ["google/gemini-3.8-live", "Google"],
    Medicare: ["spacexai/grok-voice-3.0", "xAI"],
    BioGuide: ["openai/gpt-realtime-2.1", "OpenAI"],
}

function gatewayRoute(getToken, options = {}) {
    return load("src/app/api/session/gateway/route.ts", {
        env: options.env ?? { AI_GATEWAY_REALTIME_API_KEY: "fixture-only-realtime-key" },
        dependencies: {
            ai: { createGateway: (config) => {
                options.onCreate?.(config)
                return { experimental_realtime: { getToken } }
            } },
            "@/app/lib/voice-routes": registry,
        },
    })
}

test("the five voice routes are distinct and keep greeter on direct OpenAI", () => {
    const routes = Object.values(registry.VOICE_ROUTES)
    assert.equal(routes.length, 5)
    assert.equal(new Set(routes.map(({ model }) => model.replace(/^openai\//, ""))).size, 5)
    assert.equal(registry.getVoiceRoute("greeter").transport, "direct")
    assert.equal(registry.getVoiceRoute("greeter").model, "gpt-realtime-2.1-mini")
    assert.equal(registry.getVoiceRoute("IRS").turnDetection, "semantic-vad")
    assert.match(registry.getVoiceRoute("IRS").voice, /^[A-Za-z0-9]{20}$/)
    assert.equal(registry.getVoiceRoute("__proto__"), undefined)
})

test("Gateway route mints a model-bound short-lived token for each approved agent", async () => {
    for (const [agent, [model, provider]] of Object.entries(fixtures)) {
        const minted = { token: "vcst_fixture", url: gatewaySocket(model), expiresAt: 1_900_000_000 }
        const route = gatewayRoute(async (options) => {
            assert.equal(options.model, model)
            assert.equal(options.expiresAfterSeconds, 60)
            return { ...minted, apiKey: "synthetic server credential" }
        })
        const response = await route.POST(makeRequest(`?agent=${agent}`, { model: "unapproved/model" }))
        assert.equal(response.status, 200)
        assert.match(response.headers.get("cache-control"), /private.*no-store/)
        assert.deepEqual(await response.json(), { ...minted, agent, model, provider })
    }
})

test("invalid agents, duplicate selectors, and query-level model overrides are rejected before minting", async () => {
    const route = gatewayRoute(() => assert.fail("invalid request touched AI Gateway"))
    for (const query of ["", "?agent=greeter", "?agent=Elastic", "?agent=__proto__", "?agent=IRS&agent=VA", "?agent=IRS&model=unapproved/model"]) {
        assert.equal((await route.POST(makeRequest(query))).status, 400)
    }
})

test("Gateway browser token minting requires an API key and prefers dedicated configuration", async () => {
    const request = () => makeRequest("?agent=IRS")
    const unconfigured = gatewayRoute(null, {
        env: { VERCEL_OIDC_TOKEN: "fixture-oidc-only" },
        onCreate: () => assert.fail("OIDC-only configuration attempted to mint"),
    })
    assert.equal((await unconfigured.POST(request())).status, 503)

    for (const dedicated of ["fixture-only-realtime-key", " "]) {
        const standard = "fixture-only-gateway-key"
        const route = gatewayRoute(async () => ({ token: "vcst_fixture", url: gatewaySocket(fixtures.IRS[0]) }), {
            env: { AI_GATEWAY_REALTIME_API_KEY: dedicated, AI_GATEWAY_API_KEY: standard },
            onCreate: ({ apiKey }) => assert.equal(apiKey, dedicated.trim() || standard),
        })
        const response = await route.POST(request())
        assert.equal(response.status, 200)
        assert.doesNotMatch(await response.text(), /fixture-only-(realtime|gateway)-key/)
    }
})

test("invalid or mismatched token responses fail closed without exposing raw credentials", async () => {
    const matchingUrl = gatewaySocket(fixtures.IRS[0])
    const expected = { token: "vcst_fixture", url: matchingUrl }
    for (const invalid of [
        { ...expected, token: "synthetic project credential" },
        { ...expected, url: matchingUrl.replace("ai-gateway.vercel.sh", "unknown.example") },
        { ...expected, url: matchingUrl.replace("wss:", "ws:") },
        { ...expected, url: gatewaySocket(fixtures.VA[0]) },
    ]) {
        const response = await gatewayRoute(async () => invalid).POST(makeRequest("?agent=IRS"))
        assert.equal(response.status, 502)
        assert.deepEqual(Object.keys(await response.json()), ["error"])
    }
    const route = gatewayRoute(async () => {
        throw Object.assign(new Error("synthetic server credential"), { statusCode: 403 })
    })
    const denied = await route.POST(makeRequest("?agent=IRS"))
    assert.equal(denied.status, 503)
    assert.doesNotMatch(await denied.text(), /synthetic server credential/)
})
