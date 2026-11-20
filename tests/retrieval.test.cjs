/* global require, Response, URLSearchParams, Request */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")
const next = { NextResponse: { json: (body, options) => Response.json(body, options) } }
const request = (q) => ({ nextUrl: { searchParams: new URLSearchParams({ q }) } })
const options = { index: "search-va", semanticField: "semantic_text", lexicalFields: ["title", "body_content"] }

function searchFixture(hits = []) {
    let calls = []
    const response = { timed_out: false, _shards: { failed: 0 }, hits: { hits } }
    const api = load("src/app/api/utility.ts", {
        env: { ELASTICSEARCH_CAPSTONE_URL: "https://example.test", ELASTICSEARCH_CAPSTONE_API_KEY: "test-only" },
        dependencies: {
            "next/server": next,
            "@elastic/elasticsearch": {
                Client: class {
                    async search(body) {
                        calls.push(body)
                        return response
                    }
                },
            },
        },
    })
    return { api, calls, response }
}

test("invalid search queries never call Elasticsearch", async () => {
    const { api, calls } = searchFixture()
    assert.equal((await api.handleSearch(request("  "), options)).status, 400)
    assert.equal((await api.handleSearch(request("a".repeat(2001)), options)).status, 400)
    assert.equal(calls.length, 0)
})

test("empty results are successful and hybrid search uses mapped semantic_text", async () => {
    const { api, calls } = searchFixture()
    const result = await api.handleSearch(request("benefits"), options)
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { results: [] })
    assert.equal(calls[0].retriever.rrf.retrievers[1].standard.query.semantic.field, "semantic_text")
    assert.ok(!JSON.stringify(calls[0]).includes("inference.chunks"))
})

test("retrieved fragments preserve canonical source URL and title", async () => {
    const { api } = searchFixture([
        {
            _source: {
                title: "VA benefits",
                body_content: "whole document",
                url: "https://va.gov/benefits",
                additional_urls: ["https://va.gov/help"],
            },
            highlight: { semantic_text: ["Relevant passage"] },
        },
    ])
    const { results } = await (await api.handleSearch(request("benefits"), options)).json()
    assert.equal(results[0].body_content, "Relevant passage")
    assert.equal(results[0].title, "VA benefits")
    assert.equal(results[0].url, "https://va.gov/benefits")
    assert.deepEqual(results[0].additional_urls, ["https://va.gov/help"])
})

test("partial or timed-out search is not reported as complete", async () => {
    const { api, response } = searchFixture()
    response.timed_out = true
    assert.equal((await api.handleSearch(request("benefits"), options)).status, 503)
    response.timed_out = false
    response._shards.failed = 1
    assert.equal((await api.handleSearch(request("benefits"), options)).status, 503)
})

test("email rejects malformed payloads and forwards only validated fields", async () => {
    const sent = []
    const email = load("src/app/api/sendEmail/route.ts", {
        env: { ZAP_URL: "https://example.test/email" },
        dependencies: { "next/server": next },
        globals: {
            fetch: async (url, options) => {
                sent.push(JSON.parse(options.body))
                return { ok: true }
            },
        },
    })
    const post = (body) =>
        new Request("https://example.test/api/sendEmail", {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
        })
    assert.equal((await email.POST(post("invalid JSON"))).status, 400)
    assert.equal((await email.POST(post({ email: { email: "user@example.com" }, message: [] }))).status, 400)
    assert.equal((await email.POST(post("a".repeat(100001)))).status, 413)
    assert.equal(sent.length, 0)
    assert.equal(
        (
            await email.POST(
                post({
                    email: "user@example.com",
                    message: [{ role: "user", title: "Tell me about benefits" }],
                    extra: "discard",
                }),
            )
        ).status,
        200,
    )
    assert.deepEqual(sent, [
        { email: "user@example.com", message: [{ role: "user", title: "Tell me about benefits" }] },
    ])
})

test("BioGuide prioritizes all name terms and preserves middle names", async () => {
    const { api, calls } = searchFixture([
        {
            _source: {
                givenName: "John",
                middleName: "Quincy",
                familyName: "Adams",
                usCongressBioId: "A000041",
                profileText: "Congressional biography",
            },
        },
    ])
    const route = load("src/app/api/bioguide/route.ts", { dependencies: { "../utility": api } })
    const response = await route.GET(request("John Quincy Adams"))
    const body = await response.json()
    assert.equal(body.results[0].title, "John Quincy Adams")
    assert.equal(body.results[0].bioguide_id, "A000041")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].query.multi_match.operator, "and")
    assert.equal(calls[0].query.multi_match.type, "cross_fields")
    assert.ok(calls[0].query.multi_match.fields.includes("middleName"))
    assert.ok(!calls[0].query.multi_match.fields.includes("profileText"))
})

test("BioGuide broad questions still use hybrid retrieval when names do not match", async () => {
    const { api, calls } = searchFixture()
    const route = load("src/app/api/bioguide/route.ts", { dependencies: { "../utility": api } })
    const response = await route.GET(request("members of Congress from Pennsylvania"))
    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].retriever.rrf.retrievers[1].standard.query.semantic.field, "profileText_semantic")
})
