/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

function fixture(toolLogic = {}) {
    const sent = [], breadcrumbs = []
    const telemetry = Object.fromEntries(["recordServerEvent", "recordTokenUsage", "recordToolCall", "recordResponseDoneDetails", "recordFullTranscript", "recordUserTranscript"].map(name => [name, () => {}]))
    const api = load("src/app/hooks/useHandleServerEvent.ts", {
        dependencies: {
            react: { useRef: current => ({ current }) },
            "@/app/contexts/TranscriptContext": { useTranscript: () => ({ transcriptItems: [], addTranscriptBreadcrumb: (...args) => breadcrumbs.push(args), addTranscriptMessage() {}, updateTranscriptMessage() {}, updateTranscriptItemStatus() {} }) },
            "@/app/contexts/EventContext": { useEvent: () => ({ logServerEvent() {} }) },
            "@/app/lib/client-telemetry": telemetry,
            "../lib/apm-rum": { captureError() {} },
        },
        globals: { window: {}, localStorage: { getItem: () => "test-user" }, console: { log() {}, warn() {}, error() {} } },
    })
    const handle = api.useHandleServerEvent({ selectedAgentName: "IRS", selectedAgentConfigSet: [{ name: "IRS", toolLogic }, { name: "Medicare" }], sendClientEvent: event => sent.push(event), setSelectedAgentName() {} }).current
    return { handle, sent, breadcrumbs }
}
function deferred() {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const call = (name, id, args = "{}") => ({ type: "function_call", name, call_id: id, arguments: args })
const done = (output, status = "completed") => ({ type: "response.done", response: { status, output } })

test("parallel tools finish all outputs before exactly one continuation", async () => {
    const first = deferred(), second = deferred()
    const { handle, sent } = fixture({ searchA: () => first.promise, searchB: () => second.promise })
    handle(done([call("searchA", "a"), call("searchB", "b")]))
    second.resolve({ result: "B" })
    await flush()
    assert.deepEqual(sent.map(event => event.type), ["conversation.item.create"])
    first.resolve({ result: "A" })
    await flush()
    assert.deepEqual(sent.map(event => event.type), ["conversation.item.create", "conversation.item.create", "response.create"])
    assert.deepEqual(sent.slice(0, 2).map(event => event.item.call_id).sort(), ["a", "b"])
})

test("tool failure, malformed arguments, and unavailable tool share one continuation", async () => {
    const pending = deferred()
    const { handle, sent } = fixture({ failing: () => pending.promise })
    handle(done([call("failing", "a"), call("missing", "b"), call("missing", "c", "{invalid")]))
    assert.equal(sent.filter(event => event.type === "response.create").length, 0)
    pending.reject(new Error("Search unavailable"))
    await flush()
    assert.equal(sent.length, 4)
    assert.equal(sent.at(-1).type, "response.create")
    for (const event of sent.slice(0, 3)) assert.equal(typeof JSON.parse(event.item.output).error, "string")
})

test("cancelled and failed responses do not execute tools or handoffs", async () => {
    let executions = 0
    const { handle, sent } = fixture({ search: () => { executions++; return {} } })
    for (const status of ["cancelled", "failed", "incomplete"]) {
        handle(done([call("search", "a"), call("transferAgents", "b", '{"destination_agent":"Medicare"}')], status))
    }
    await flush()
    assert.equal(executions, 0)
    assert.equal(sent.length, 0)
})

for (const boundary of ["session.created", "session.disconnected"]) {
    test(`late tool outputs do not cross ${boundary}`, async () => {
        const pending = deferred()
        const { handle, sent, breadcrumbs } = fixture({ search: () => pending.promise })
        handle({ type: "session.created", session: { id: "old-session" } })
        handle(done([call("search", "old-call")]))
        handle({ type: boundary, session: { id: "new-session" } })
        pending.resolve({ result: "stale data" })
        await flush()
        assert.equal(sent.length, 0)
        assert.ok(!JSON.stringify(breadcrumbs).includes("stale data"))
        handle(done([call("unavailable", "new-call")]))
        await flush()
        assert.equal(sent[0].item.call_id, "new-call")
        assert.equal(sent[1].type, "response.create")
    })
}

test("handoff still skips siblings and creates its confirmation-only introduction once", async () => {
    let searches = 0
    const { handle, sent } = fixture({ search: () => { searches++; return {} } })
    handle(done([call("search", "a"), call("transferAgents", "b", '{"destination_agent":"Medicare","user_question":"When should my dad enroll?"}')]))
    await flush()
    assert.equal(searches, 0)
    assert.equal(JSON.parse(sent[0].item.output).skipped, true)
    const responses = sent.filter(event => event.type === "response.create")
    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.tool_choice, "none")
    assert.match(responses[0].response.instructions, /receiving Medicare specialist/)
})
