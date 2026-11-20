/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const { Buffer } = require("node:buffer")
const { setImmediate: waitForReplay } = require("node:timers/promises")
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
    let pendingAudioSends = 0
    let peakPendingAudioSends = 0
    const playbackChanges = []
    class SdkSession {
        constructor(options) {
            sessions.push(this)
            this.options = options
            this.state = { isPlaying: false }
        }
        async connect(options) {
            this.connectOptions = options
        }
        startAudioCapture(stream) { media = stream }
        sendEvent(event) {
            const serialized = this.options.model.serializeClientEvent(event)
            if (serialized != null) sent.push(serialized)
            if (serialized?.type !== "input-audio-append") return Promise.resolve()
            pendingAudioSends++
            peakPendingAudioSends = Math.max(peakPendingAudioSends, pendingAudioSends)
            return Promise.resolve().then(() => { pendingAudioSends-- })
        }
        stopPlayback() { stops++ }
        async resumePlayback() {}
        dispose() { this.disposed = true }
    }
    const { GatewayRealtimeTransport } = load("src/app/hooks/gatewayRealtimeTransport.ts", {
        globals: { setTimeout: (callback) => Promise.resolve().then(callback) },
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
        onPlaybackChange: (isPlaying) => playbackChanges.push(isPlaying),
        onOpen: () => { opens++ },
        onClose: () => { closes++ },
        onError: () => { errors++ },
    })
    const [session] = sessions
    return {
        transport, session, sent, events, playbackChanges, media: () => media, opens: () => opens, closes: () => closes, stops: () => stops, errors: () => errors,
        status: (status) => session.setState("status", status),
        receive: (event) => session.options.onEvent(event),
        capture: (audio) => session.sendEvent({ type: "input-audio-append", audio }),
        peakPendingAudioSends: () => peakPendingAudioSends,
        playback: (isPlaying) => {
            session.state.isPlaying = isPlaying
            session.setState("isPlaying", isPlaying)
        },
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

test("Gateway reports actual SDK playout changes while the session is open", () => {
    const { transport, session, status, playbackChanges } = gatewayFixture()
    status("connected")
    session.state.isPlaying = true
    session.setState("isPlaying", true)
    assert.equal(transport.isAudioPlaying, true)
    session.state.isPlaying = false
    session.setState("isPlaying", false)
    assert.equal(transport.isAudioPlaying, false)
    assert.deepEqual(playbackChanges, [true, false])
    transport.close()
    session.setState("isPlaying", true)
    assert.deepEqual(playbackChanges, [true, false])
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

const audioFrames = (events) => events.filter(({ type }) => type === "input-audio-append").map(({ audio }) => audio)

test("Gateway retains hands-free audio from response request through playback and replays it in order", async () => {
    const { transport, sent, events, status, receive, capture, playback } = gatewayFixture()
    status("connected")
    capture("before-reply")
    transport.send({ type: "response.create" })
    capture("request-to-start")
    receive({ type: "response-created", responseId: "answer" })
    capture("generating")
    playback(true)
    receive({ type: "response-done", responseId: "answer", status: "completed" })
    capture("audible-tail")
    assert.deepEqual(sent.map(({ type }) => type), ["input-audio-append", "response-create"])

    playback(false)
    // A provider may detect speech before the rest of the captured turn is sent.
    receive({ type: "speech-started" })
    capture("live-input-during-replay")
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), ["before-reply", "request-to-start", "generating", "audible-tail", "live-input-during-replay"])

    receive({ type: "input-transcription-completed", itemId: "overlap", transcript: "Transfer me to the IRS specialist." })
    assert.equal(events.at(-1).type, "conversation.item.input_audio_transcription.completed")
    assert.equal(events.at(-1).transcript, "Transfer me to the IRS specialist.")
})

test("Gateway pauses microphone replay when another response starts and resumes after its completion", async () => {
    const { sent, status, receive, capture, playback } = gatewayFixture()
    status("connected")
    receive({ type: "response-created", responseId: "first" })
    playback(true)
    capture("overlap-start")
    capture("overlap-end")
    playback(false)
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), [])

    receive({ type: "response-done", responseId: "first", status: "completed" })
    receive({ type: "response-created", responseId: "second" })
    capture("second-overlap")
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), ["overlap-start"])

    receive({ type: "response-done", responseId: "second", status: "completed" })
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), ["overlap-start", "overlap-end", "second-overlap"])
})

test("Gateway discards held audio on explicit interruption or disconnect", async () => {
    const { transport, sent, status, receive, capture, playback } = gatewayFixture()
    status("connected")
    receive({ type: "response-created", responseId: "interrupted" })
    capture("discard-on-interrupt")
    transport.stopPlayback()
    receive({ type: "response-done", responseId: "interrupted", status: "cancelled" })
    capture("fresh-input")
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), ["fresh-input"])

    playback(true)
    capture("discard-on-close")
    transport.close()
    playback(false)
    capture("retired-capture")
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), ["fresh-input"])
})

test("Gateway retains early microphone input through 64 seconds of reply and submits replay sequentially", async () => {
    for (const samplesPerFrame of [1024, 512]) {
        const { sent, status, receive, capture, playback, peakPendingAudioSends } = gatewayFixture()
        status("connected")
        receive({ type: "response-created", responseId: "long-reply" })
        playback(true)
        const pcm = Buffer.alloc(samplesPerFrame * 2)
        const frames = Array.from({ length: 64 * 24_000 / samplesPerFrame }, (_, sequence) => {
            pcm.writeUInt16LE(sequence)
            return pcm.toString("base64")
        })
        for (const frame of frames) capture(frame)

        receive({ type: "response-done", responseId: "long-reply", status: "completed" })
        await waitForReplay()
        assert.deepEqual(audioFrames(sent), [])

        playback(false)
        await waitForReplay()
        const replayed = audioFrames(sent)
        assert.equal(replayed.length, frames.length)
        assert.ok(replayed.every((frame, sequence) => frame === frames[sequence]))
        assert.equal(peakPendingAudioSends(), 1)
    }
})

test("Gateway bounds the number and byte size of retained audio frames", async () => {
    const { sent, status, capture, playback } = gatewayFixture()
    status("connected")
    playback(true)
    for (let i = 0; i < 3_272; i++) capture(String(i))
    playback(false)
    await waitForReplay()
    assert.deepEqual(audioFrames(sent), Array.from({ length: 3_200 }, (_, i) => String(i + 72)))

    sent.length = 0
    playback(true)
    const frame = "AAAA".repeat(1250)
    for (let i = 0; i < 901; i++) capture(frame)
    playback(false)
    await waitForReplay()
    assert.equal(audioFrames(sent).length, 900)
})
