/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

function gatewayFixture() {
    const sent = []
    const events = []
    const sessions = []
    let media
    let opens = 0
    let closes = 0
    let errors = 0
    let stops = 0
    class SdkSession {
        constructor(options) {
            sessions.push(this)
            this.options = options
        }
        async connect(options) {
            this.connectOptions = options
        }
        startAudioCapture(stream) { media = stream }
        sendEvent(event) {
            sent.push(event)
            return Promise.resolve()
        }
        stopPlayback() { stops++ }
        async resumePlayback() {}
        dispose() { this.disposed = true }
    }
    const { GatewayRealtimeTransport } = load("src/app/hooks/gatewayRealtimeTransport.ts", {
        dependencies: {
            ai: {
                Experimental_AbstractRealtimeSession: SdkSession,
                gateway: {
                    experimental_realtime: (modelId) => ({
                        modelId,
                        specificationVersion: "v4",
                        provider: "gateway",
                        parseServerEvent: (event) => event,
                        serializeClientEvent: (event) => event,
                        buildSessionConfig: (config) => config,
                    }),
                },
            },
        },
    })
    const transport = new GatewayRealtimeTransport({
        agent: "VA",
        model: "google/gemini-3.8-live",
        config: { instructions: "Use the VA index." },
        playbackEnabled: true,
        onEvent: (event) => events.push(event),
        onOpen: () => { opens++ },
        onClose: () => { closes++ },
        onError: () => { errors++ },
    })
    const [session] = sessions
    return {
        transport, session, sent, events, media: () => media, opens: () => opens, closes: () => closes, stops: () => stops, errors: () => errors,
        status: (status) => session.setState("status", status),
        receive: (event) => session.options.onEvent(event),
    }
}

test("Gateway readiness gates capture and uses the agent and model scoped token endpoint", async () => {
    const fixture = gatewayFixture()
    const stream = {}
    await fixture.transport.connect(stream)
    assert.equal(fixture.transport.readyState, "connecting")
    assert.equal(fixture.session.options.model.modelId, "google/gemini-3.8-live")
    assert.equal(fixture.session.options.api.token, "/api/session/gateway?agent=VA")
    assert.equal(fixture.session.connectOptions.capture, false)
    fixture.transport.startCapture()
    assert.equal(fixture.media(), undefined)

    fixture.status("connected")
    fixture.transport.startCapture()
    assert.equal(fixture.media(), stream)
    assert.equal(fixture.transport.readyState, "open")
    assert.equal(fixture.opens(), 1)

    fixture.transport.close()
    fixture.status("disconnected")
    fixture.receive({ type: "response-created", responseId: "retired" })
    assert.equal(fixture.events.length, 0)
    assert.equal(fixture.closes(), 0)
    assert.equal(fixture.session.disposed, true)
    assert.equal(fixture.transport.readyState, "closed")
})

test("Gateway normalizes caller and assistant transcript and batches completed tool calls", () => {
    const { transport, sent, events, receive, status } = gatewayFixture()
    status("connected")
    receive({ type: "input-transcription-completed", itemId: "caller", transcript: "Where is the VA office?" })
    receive({ type: "response-created", responseId: "response" })
    receive({ type: "audio-transcript-delta", responseId: "response", itemId: "reply", delta: "Let me check." })
    receive({ type: "audio-transcript-done", responseId: "response", itemId: "reply", transcript: "Let me check the VA index." })
    receive({ type: "function-call-arguments-done", responseId: "response", itemId: "tool", callId: "lookup", name: "searchVA", arguments: "{}" })
    assert.equal(events.some((event) => event.type === "response.done"), false)
    receive({
        type: "response-done", responseId: "response", status: "completed", usage: { inputTokens: 2, outputTokens: 3 },
        raw: { examplePrivateField: "should not appear" },
    })
    const done = events.at(-1).response
    assert.equal(events[1].transcript, "Where is the VA office?")
    assert.equal(done.output[0].content[0].transcript, "Let me check the VA index.")
    assert.equal(done.output[1].name, "searchVA")
    assert.equal(done.usage.total_tokens, 5)
    assert.equal(done.model, "google/gemini-3.8-live")
    assert.equal(JSON.stringify(events).includes("examplePrivateField"), false)
    transport.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "lookup", output: "{}" } })
    transport.send({ type: "response.create" })
    assert.equal(sent[0].item.name, "searchVA")
    assert.equal(sent[0].item.callId, "lookup")
    assert.equal(sent[1].type, "response-create")
    assert.equal(sent.length, 2)
})

test("Gateway mute and interruption drop audio without dropping transcript events", async () => {
    const { transport, session, status, receive, stops } = gatewayFixture()
    status("connected")
    const parse = session.options.model.parseServerEvent
    const audio = { type: "audio-delta", responseId: "previous", delta: "test" }
    const transcript = { type: "audio-transcript-delta", responseId: "previous", delta: "test" }
    assert.equal(parse(audio).length, 1)
    receive({ type: "response-created", responseId: "previous" })
    receive({ type: "speech-started" })
    assert.equal(stops(), 1)
    assert.equal(parse(audio).length, 0)
    assert.equal(parse(transcript).length, 1)
    await transport.setPlaybackEnabled(false)
    assert.equal(parse({ ...audio, responseId: "new" }).length, 0)
    await transport.setPlaybackEnabled(true)
    assert.equal(parse({ ...audio, responseId: "new" }).length, 1)
})

test("Gateway identifies a Gemini turn even when no response-created arrived", () => {
    const { events, receive, status } = gatewayFixture()
    status("connected")
    receive({ type: "function-call-arguments-done", responseId: "first", callId: "lookup", name: "searchVA", arguments: "{}" })
    receive({ type: "response-done", responseId: "first", status: "completed" })
    receive({ type: "response-done", responseId: "first", status: "completed" })
    receive({ type: "response-done", responseId: "second", status: "completed" })
    assert.deepEqual(events.map(({ type, response }) => [type, response.id]), [
        ["response.created", "first"], ["response.done", "first"],
        ["response.created", "second"], ["response.done", "second"],
    ])
})
