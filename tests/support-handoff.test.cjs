/* global require, Request, ReadableStream, TextEncoder */
const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const load = require("./helpers/load-typescript.cjs")

let workflowErrors
test.before(async () => { workflowErrors = await import("workflow/errors") })

const endpoint = "https://demo.example/api/support/handoffs"
const secret = "fixture-only-signing-key-not-for-deployment"
const input = {
    question: "What congressional offices did John Quincy Adams hold, and when?",
    transcript: "Caller: What congressional offices did John Quincy Adams hold, and when?",
}
const request = load("src/app/api/support/handoffs/request.ts", {
    dependencies: { "node:crypto": crypto },
    env: { HANDOFF_RECEIPT_SECRET: secret },
})
const post = (body = input, key) => new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key && { "Idempotency-Key": key }) },
    body: JSON.stringify(body),
})
const get = (receipt) => new Request(endpoint, {
    headers: receipt ? { "x-fedflow-receipt": receipt } : {},
})

function routeFixture(workflowApi, requestOverrides = {}) {
    return load("src/app/api/support/handoffs/route.ts", {
        dependencies: {
            "workflow/api": workflowApi,
            "workflow/errors": workflowErrors,
            "@/app/workflows/support-handoff": { draftSupportHandoff() {} },
            "./request": { ...request, ...requestOverrides },
        },
    })
}

test("handoff start returns a private receipt; polling reads the same run without restarting it", async () => {
    const completed = { status: "grounded", summary: "A call about John Quincy Adams.", nextStep: "Review his BioGuide record.", sources: [] }
    let starts = 0
    let status = "running"
    const route = routeFixture({
        async start(_workflow, [payload]) {
            assert.equal(payload.question, input.question)
            assert.equal(payload.transcript, input.transcript)
            starts++
            return { runId: "wrun_test" }
        },
        getRun(runId) {
            assert.equal(runId, "wrun_test")
            return {
                status: Promise.resolve(status),
                get returnValue() {
                    assert.equal(status, "completed", "pending status must never wait for the draft")
                    return Promise.resolve(completed)
                },
            }
        },
    })
    const response = await route.POST(post())
    assert.equal(response.status, 202)
    assert.match(response.headers.get("cache-control"), /private.*no-store/)
    const { receipt } = await response.json()
    assert.deepEqual(await (await route.GET(get(receipt))).json(), { status: "pending" })
    status = "completed"
    assert.deepEqual(await (await route.GET(get(receipt))).json(), { status: "complete", result: completed })
    status = "failed"
    assert.equal((await (await route.GET(get(receipt))).json()).status, "failed")
    assert.equal(starts, 1)
})

test("invalid or expired receipts cannot look up a workflow run", async () => {
    const route = routeFixture({
        getRun() { assert.fail("invalid receipt reached the workflow API") },
    })
    const receipt = request.issueReceipt("wrun_test", secret)
    const invalidSignature = receipt.replace(/.$/, (last) => last === "A" ? "B" : "A")
    const wrongSecret = request.issueReceipt("wrun_test", "a different fixture signing key, not for deployment")
    const expired = request.issueReceipt("wrun_test", secret, Date.now() - 25 * 60 * 60 * 1000)
    for (const token of [undefined, "wrun_test", invalidSignature, wrongSecret, expired]) {
        assert.equal((await route.GET(get(token))).status, 404)
    }
})

test("a lost keyed start response and concurrent retries recover the canonical run and receipt", async () => {
    const key = crypto.randomUUID()
    const owners = new Map()
    const runs = new Map()
    const route = routeFixture({
        async start(_workflow, _input, options) {
            const { token, metadata, experimental_minRetention } = options.experimental_hook
            assert.equal(experimental_minRetention, "25h")
            assert.ok(token.startsWith("fedflow-handoff-start:v1:"))
            assert.ok(!token.includes(input.transcript) && !token.includes(key))
            assert.match(metadata, /^[A-Za-z0-9_-]{43}$/)
            const owner = owners.get(token)
            if (owner) throw new workflowErrors.HookConflictError(token, owner.runId, { kind: "start" })
            const run = { runId: `wrun_${runs.size + 1}`, createdAt: Promise.resolve(new Date()), status: Promise.resolve("running") }
            owners.set(token, { runId: run.runId, metadata: Promise.resolve(metadata) })
            runs.set(run.runId, run)
            if (runs.size === 1) throw new Error("The first admission acknowledgement was lost.")
            return run
        },
        async getHookByToken(token) { return owners.get(token) },
        getRun(runId) { return runs.get(runId) },
    })

    assert.equal((await route.POST(post(input, key))).status, 503)
    const responses = await Promise.all([
        route.POST(post(input, key)),
        route.POST(post({ ...input, question: ` ${input.question} ` }, key.toUpperCase())),
    ])
    assert.ok(responses.every((response) => response.status === 202))
    const receipts = await Promise.all(responses.map(async (response) => (await response.json()).receipt))
    assert.equal(receipts[0], receipts[1])
    assert.equal(request.verifyReceipt(receipts[0], secret), "wrun_1")
    assert.equal(runs.size, 1)
    assert.deepEqual(await (await route.GET(get(receipts[0]))).json(), { status: "pending" })

    const edited = await route.POST(post({ ...input, question: "Which other office did he hold?" }, key))
    assert.equal(edited.status, 409)
    assert.equal(runs.size, 1)
    const distinct = await route.POST(post(input, crypto.randomUUID()))
    assert.equal(distinct.status, 202)
    assert.equal(request.verifyReceipt((await distinct.json()).receipt, secret), "wrun_2")
})

test("missing and purged runs return a terminal response while outages remain retryable", async () => {
    const receipt = request.issueReceipt("wrun_old", secret)
    const getMissing = async (error) => routeFixture({
        getRun() { return { status: Promise.reject(error) } },
    }).GET(get(receipt))

    const missing = await getMissing(new workflowErrors.WorkflowRunNotFoundError("wrun_old"))
    const expired = await routeFixture({
        getRun() {
            return {
                status: Promise.resolve("completed"),
                get returnValue() { return Promise.reject(new workflowErrors.RunExpiredError("internal purge detail")) },
            }
        },
    }).GET(get(receipt))
    for (const response of [missing, expired]) {
        assert.equal(response.status, 404)
        assert.deepEqual(await response.json(), { error: "The handoff receipt is invalid or expired." })
    }
    assert.equal((await getMissing(new Error("internal outage detail"))).status, 503)
})

test("a retained start key cannot renew an expired receipt", async () => {
    const key = crypto.randomUUID()
    let fingerprint
    const route = routeFixture({
        async start(_workflow, _input, options) {
            fingerprint = options.experimental_hook.metadata
            throw new workflowErrors.HookConflictError(options.experimental_hook.token, "wrun_expired", { kind: "start" })
        },
        async getHookByToken() { return { runId: "wrun_expired", metadata: Promise.resolve(fingerprint) } },
        getRun() { return { runId: "wrun_expired", createdAt: Promise.resolve(new Date(Date.now() - request.RECEIPT_LIFETIME_MS)) } },
    })
    const response = await route.POST(post(input, key))
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: "The handoff receipt is invalid or expired." })
})

test("invalid and oversized handoff submissions cannot start a workflow", async () => {
    const route = routeFixture({ start() { assert.fail("invalid input started a workflow") } })
    for (const value of [null, [], {}, { ...input, question: " " }, { ...input, transcript: "x".repeat(4001) }]) {
        assert.equal((await route.POST(post(value))).status, 400)
    }
    assert.equal((await route.POST(post(input, "not-a-uuid"))).status, 400)
    const headers = { "content-type": "application/json" }
    assert.equal((await route.POST(new Request(endpoint, { method: "POST", headers, body: "broken" }))).status, 400)
    assert.equal((await route.POST(new Request(endpoint, { method: "POST", body: "raw" }))).status, 415)
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(33_000)))
            controller.close()
        },
    })
    assert.equal((await route.POST(new Request(endpoint, { method: "POST", headers, body, duplex: "half" }))).status, 413)
    const disabled = routeFixture({}, { getReceiptSecret: () => undefined })
    assert.equal((await disabled.POST(post())).status, 503)
})

const link = "https://bioguide.congress.gov/search/bio/A000041"
const hit = {
    _source: {
        givenName: "John",
        middleName: "Quincy",
        familyName: "Adams",
        usCongressBioId: "a000041",
        profileText: "Served in the U.S. Senate from 1803 to 1808 and the U.S. House from 1831 to 1848.",
    },
}
const draft = {
    status: "grounded",
    summary: "John Quincy Adams served in the U.S. Senate from 1803 to 1808 and the U.S. House from 1831 to 1848.",
    nextStep: "Check the linked BioGuide entry for the exact service dates.",
    sourceIds: ["S1"],
}

function workflowFixture({
    sources = [hit],
    output = draft,
    response = { timed_out: false, _shards: { failed: 0 } },
    searchError,
    modelError,
} = {}) {
    const calls = []
    class FatalError extends Error {}
    class RetryableError extends Error {}
    const validator = () => "validator"
    const retrieval = load("src/app/api/utility.ts", {
        dependencies: { "next/server": {}, "@elastic/elasticsearch": {} },
    })
    const api = load("src/app/workflows/support-handoff.ts", {
        dependencies: {
            ai: {
                APICallError: { isInstance: (error) => error?.apiCall },
                NoObjectGeneratedError: { isInstance: (error) => error?.invalidObject },
                Output: { object: (value) => value },
                async generateText(options) {
                    calls.push({ model: options.model, maxRetries: options.maxRetries, prompt: JSON.parse(options.prompt) })
                    if (modelError) throw modelError
                    return {
                        output,
                        response: { modelId: "openai/gpt-5-mini" },
                        usage: { inputTokens: 20, outputTokens: 10 },
                        providerMetadata: { gateway: { cost: "0.000031" } },
                    }
                },
            },
            workflow: { FatalError, RetryableError },
            linkifyjs: require("linkifyjs"),
            zod: { z: { object: validator, enum: validator, string: validator, array: validator } },
            "@/app/api/utility": {
                bioGuideSearch: retrieval.bioGuideSearch,
                extractBioGuideResults: retrieval.extractBioGuideResults,
                async searchDocuments(query, options) {
                    calls.push({ query, ...options })
                    if (searchError) throw searchError
                    return { ...response, hits: { hits: sources } }
                },
            },
        },
    })
    return { ...api, calls, FatalError, RetryableError }
}

test("handoff uses the shared BioGuide corpus and derives official citations from indexed member IDs", async () => {
    const fixture = workflowFixture({
        sources: [
            { _source: { ...hit._source, usCongressBioId: "A000041/extra", url: link } },
            {
                highlight: { profileText_semantic: ["U.S. Senate from 1803 to 1808"] },
                _source: {
                    ...hit._source,
                    url: "https://bioguide.congress.gov.example/invalid",
                    profileText: `U.S. Senate from 1803 to 1808. ${"x".repeat(1800)} U.S. House from 1831 to 1848. ${"x".repeat(1800)}`,
                },
            },
            hit,
        ],
        output: { ...draft, sourceIds: ["S1", "S1"] },
    })
    const result = await fixture.draftSupportHandoff(input)
    assert.equal(result.status, "grounded")
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].url, link)
    assert.equal(result.sources[0].title, "John Quincy Adams")
    assert.equal(result.sources[0].id, "S1")
    assert.equal(result.usage.costUsd, "0.000031")
    assert.equal(result.usage.inputTokens, 20)
    assert.equal(fixture.calls[0].index, "person")
    assert.equal(fixture.calls[0].semanticField, "profileText_semantic")
    assert.ok(fixture.calls[0].nameFields.includes("middleName"))
    assert.ok(fixture.calls[0].lexicalFields.includes("profileText"))
    assert.equal(fixture.calls[0].size, 3)
    assert.equal(fixture.calls[0].requestTimeout, 8000)
    assert.equal(fixture.calls[0].query, input.question)
    assert.equal(fixture.calls[1].model, "openai/gpt-5-mini")
    assert.equal(fixture.calls[1].maxRetries, 0)
    assert.equal(fixture.calls[1].prompt.evidence[0].excerpt.length, 3000)
    assert.match(fixture.calls[1].prompt.evidence[0].excerpt, /U.S. House from 1831 to 1848/)
    assert.equal(fixture.calls[1].prompt.evidence[0].url, undefined)
})

test("empty evidence avoids generation; irrelevant evidence and invalid model links safely abstain", async () => {
    for (const sources of [[], [{ _source: { ...hit._source, usCongressBioId: undefined, url: link } }]]) {
        const noHits = workflowFixture({ sources })
        assert.equal((await noHits.draftSupportHandoff(input)).status, "insufficient_evidence")
        assert.equal(noHits.calls.length, 1)
    }

    for (const output of [
        { ...draft, status: "insufficient_evidence" },
        { ...draft, sourceIds: ["uncited"] },
        { ...draft, nextStep: "Read https://example.com first." },
        { ...draft, summary: "See bioguide.congress.gov/search/bio/A000041." },
        { ...draft, nextStep: "Verify [the BioGuide record](/search/bio/A000041)." },
        { ...draft, nextStep: "Verify [the record][bio].\n\n[bio]: /search/bio/A000041" },
        { ...draft, summary: "He served in the U.S. Senate [S2]." },
    ]) {
        const result = await workflowFixture({ output }).draftSupportHandoff(input)
        assert.equal(result.status, "insufficient_evidence")
        assert.equal(result.sources.length, 0)
    }
})

test("draft text can cite any of its validated source IDs without introducing another link", async () => {
    const output = { ...draft, summary: `${draft.summary} [S1]`, nextStep: "Check the listed record [S1] (service dates)." }
    const result = await workflowFixture({ output }).draftSupportHandoff(input)
    assert.equal(result.status, "grounded")
    assert.equal(result.summary, output.summary)
    assert.equal(result.nextStep, output.nextStep)
    assert.equal(result.sources.length, 1)
})

test("search and provider outages fail the run with sanitized retryable errors", async () => {
    const fixture = workflowFixture({ response: { timed_out: true, _shards: { failed: 0 } } })
    await assert.rejects(fixture.draftSupportHandoff(input), {
        name: "Error",
        message: "The knowledge base is unavailable.",
    })
    assert.equal(fixture.calls.length, 1)

    const providerFailure = workflowFixture({ modelError: new Error("raw transcript and key") })
    await assert.rejects(providerFailure.draftSupportHandoff(input), (error) =>
        error instanceof providerFailure.RetryableError && error.message === "The model is unavailable.",
    )
    const permanent = workflowFixture({ searchError: { statusCode: 401, message: "raw key" } })
    await assert.rejects(permanent.draftSupportHandoff(input), (error) =>
        error instanceof permanent.FatalError && error.message === "The knowledge base is unavailable.",
    )
})
