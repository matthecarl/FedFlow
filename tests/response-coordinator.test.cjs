/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")
const { RealtimeResponseCoordinator } = load("src/app/lib/realtimeResponseCoordinator.ts")

function fixture() {
    const sent = []
    let eventId = 0
    const coordinator = new RealtimeResponseCoordinator(event => sent.push(event), () => `event-${++eventId}`)
    const receive = event => { coordinator.receive(event); coordinator.flush() }
    const created = id => receive({ type: "response.created", response: { id } })
    const done = (id, output = [], status = "completed") => receive({ type: "response.done", response: { id, output, status } })
    const request = (response) => coordinator.request({ type: "response.create", ...(response ? { response } : {}) })
    return { coordinator, sent, receive, created, done, request }
}

test("rapid interruptions wait for created and matching cancelled completion, sending one latest reply", () => {
    const { coordinator, sent, request, created, done } = fixture()
    request()
    coordinator.interrupt()
    request({ instructions: "first question" })
    coordinator.interrupt()
    request({ instructions: "latest question" })
    assert.equal(sent.length, 1)
    created("greeting")
    coordinator.interrupt()
    request({ instructions: "latest question" })
    assert.equal(sent.length, 2)
    assert.equal(sent[1].type, "response.cancel")
    assert.equal(sent[1].response_id, "greeting")
    done("greeting", [], "cancelled")
    assert.equal(sent.length, 3)
    assert.equal(sent[2].response.instructions, "latest question")
})

test("late completion cannot release an in-flight or newer identified response", () => {
    const { sent, request, created, done } = fixture()
    request(); created("old"); done("old")
    request(); request()
    done("old")
    assert.equal(sent.length, 2)
    created("new"); done("old")
    assert.equal(sent.length, 2)
    done("new")
    assert.equal(sent.length, 3)
})

test("VAD/short PTT commits queue behind cancellation and do not respond while speech is pending", () => {
    const { coordinator, sent, request, created, done, receive } = fixture()
    request(); created("answer")
    coordinator.beginInput()
    request() // A tool continuation arriving during speech must wait too.
    done("answer", [], "cancelled")
    assert.equal(sent.length, 2)
    receive({ type: "input_audio_buffer.committed", item_id: "spoken-question" })
    assert.equal(sent.length, 3)
    assert.equal(sent[2].type, "response.create")
    assert.ok(sent[2].event_id)
})

test("committing speech before cancellation finishes still waits for acknowledgement", () => {
    const { coordinator, sent, request, created, done, receive } = fixture()
    request(); created("answer"); coordinator.beginInput()
    receive({ type: "input_audio_buffer.committed" })
    assert.equal(sent.length, 2)
    done("answer", [], "cancelled")
    assert.equal(sent.length, 3)
})

test("voice input during parallel tools waits for all outputs and one complete continuation", () => {
    const { coordinator, sent, request, created, done, receive } = fixture()
    request(); created("search")
    done("search", ["a", "b"].map(call_id => ({ type: "function_call", name: "search", arguments: "{}", call_id })))
    coordinator.beginInput(); receive({ type: "input_audio_buffer.committed" })
    coordinator.toolOutputSent("a"); coordinator.flush()
    assert.equal(sent.length, 1)
    coordinator.toolOutputSent("b")
    request()
    assert.equal(sent.length, 2)
})

test("queued specialist introduction retains instructions and tool restrictions", () => {
    const { coordinator, sent, request, created, done, receive } = fixture()
    request(); created("handoff")
    done("handoff", [{ type: "function_call", call_id: "transfer", name: "transferAgents", arguments: "{}" }])
    coordinator.beginInput()
    coordinator.toolOutputSent("transfer")
    const response = { instructions: "Confirm the question", tools: [], tool_choice: "none", max_output_tokens: 1024 }
    request(response)
    assert.equal(sent.length, 1)
    // A user commit now supersedes this intro, so test release via unrelated input error instead.
    receive({ type: "error", error: { code: "input_audio_buffer_commit_empty" } })
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1].response, response)
})

test("reset discards queued work and tool holds before reconnect", () => {
    const { coordinator, sent, request, created, done } = fixture()
    request(); created("search")
    done("search", [{ type: "function_call", call_id: "a", name: "search", arguments: "{}" }])
    request(); coordinator.reset(); coordinator.flush()
    assert.equal(sent.length, 1)
    request(); created("new-session"); done("search")
    assert.equal(sent.length, 2)
})

test("unrelated errors cannot unlock a response but a rejected create can be retried", () => {
    const { sent, request, receive } = fixture()
    request()
    receive({ type: "error", error: { event_id: "different", code: "invalid_request_error" } })
    request()
    assert.equal(sent.length, 1)
    receive({ type: "error", error: { event_id: sent[0].event_id, code: "invalid_request_error" } })
    assert.equal(sent.length, 2)
})

test("discarding audio during an input-mode change cannot leave a pending continuation stuck", () => {
    const { coordinator, sent, request } = fixture()
    coordinator.beginInput()
    request({ instructions: "Confirm the transferred question" })
    assert.equal(sent.length, 0)
    coordinator.discardInput()
    coordinator.flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].response.instructions, "Confirm the transferred question")
})
