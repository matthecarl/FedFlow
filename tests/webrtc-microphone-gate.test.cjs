/* global require, __dirname, AbortController */
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const load = require("./helpers/load-typescript.cjs")

const processorPath = path.join(__dirname, "../public/fedflow-microphone.worklet.js")

function fixture() {
    let FedFlowMicrophone
    const events = []
    vm.runInNewContext(fs.readFileSync(processorPath, "utf8"), {
        AudioWorkletProcessor: class {
            port = { postMessage: (message) => events.push(message) }
        },
        sampleRate: 100,
        registerProcessor(name, processor) {
            assert.equal(name, "fedflow-microphone")
            FedFlowMicrophone = processor
        },
    })
    const processor = new FedFlowMicrophone()
    return {
        processor,
        events,
        command: (data) => processor.port.onmessage({ data }),
        frame(signal = 0) {
            const input = new Float32Array(10).fill(signal)
            const output = new Float32Array(10)
            processor.process([[input]], [[output]])
            return Math.round(output[0] * 100)
        },
    }
}

test("WebRTC microphone holds speech and replays it in sequence with new speech during catch-up", () => {
    const { events, command, frame } = fixture()
    assert.equal(frame(0.1), 10)
    command("hold")
    for (let i = 0; i < 75; ++i) assert.equal(frame(), 0)
    assert.equal(frame(0.2), 0)
    assert.equal(frame(0.3), 0)
    for (let i = 0; i < 25; ++i) assert.equal(frame(), 0)
    assert.deepEqual(events, ["speech-buffered"])

    command("release")
    const output = [
        frame(0.4), frame(0.5), frame(), frame(), frame(),
        ...Array.from({ length: 36 }, () => frame()),
    ]
    assert.deepEqual(output.slice(0, 5), [0, 0, 0, 20, 30])
    assert.deepEqual(output.filter(Boolean), [20, 30, 40, 50])
    assert.equal(frame(0.6), 60)
})

test("quiet input is bounded for long replies and can resume immediately", () => {
    const { processor, events, command, frame } = fixture()
    command("hold")
    for (let i = 0; i < 750; ++i) assert.equal(frame(), 0)
    assert.equal(processor.write - processor.read, 6000)
    assert.deepEqual(events, [])
    command("release")
    assert.equal(frame(0.7), 70)
})

test("explicit interruption discards buffered audio before returning to live capture", () => {
    const { command, frame } = fixture()
    command("hold")
    assert.equal(frame(0.2), 0)
    assert.equal(frame(0.3), 0)
    command("discard")
    assert.equal(frame(0.7), 70)
    assert.equal(frame(), 0)
})

test("cancelled startup closes the audio context and both microphone tracks before a late worklet load", async () => {
    const stops = []
    let finishModule
    const microphone = { getTracks: () => [{ stop: () => stops.push("input") }] }
    class AudioContext {
        audioWorklet = {
            addModule(pathname) {
                assert.equal(pathname, "/fedflow-microphone.worklet.js")
                return new Promise((resolve) => { finishModule = resolve })
            },
        }
        createMediaStreamDestination() {
            return { stream: { getAudioTracks: () => [{ stop: () => stops.push("sender") }] } }
        }
        async close() { stops.push("context") }
    }
    const { createWebRtcMicrophoneGate } = load("src/app/lib/webrtcMicrophoneGate.ts", { globals: { AudioContext } })
    const controller = new AbortController()
    const result = createWebRtcMicrophoneGate(microphone, controller.signal)
    controller.abort()
    assert.deepEqual(stops, ["sender", "input", "context"])
    finishModule()
    await assert.rejects(result, { name: "AbortError" })
    assert.equal(stops.length, 3)
})
