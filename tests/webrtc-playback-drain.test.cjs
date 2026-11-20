/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

function fixture() {
    let scheduled
    let sample = null
    let drains = 0
    const { watchWebRtcPlayback } = load("src/app/lib/webrtcMicrophoneGate.ts", {
        globals: {
            setTimeout(callback) { scheduled = callback; return 1 },
            clearTimeout() { scheduled = undefined },
        },
    })
    const watch = watchWebRtcPlayback(() => sample, () => { drains++ })
    return {
        watch,
        drains: () => drains,
        sample(time, rms = 0) {
            sample = time === null ? null : { time, rms, duration: 0.17 }
            scheduled?.()
        },
        quietFrom(time, observations) {
            for (let i = 0; i < observations; i++) this.sample(time + i * 0.1)
        },
    }
}

test("a heard reply must finish generating and produce a continuous quiet tail before fallback", () => {
    const playback = fixture()
    playback.sample(0, 0.05)
    playback.quietFrom(0.1, 20)
    assert.equal(playback.drains(), 0)
    playback.watch.generationCompleted()
    playback.quietFrom(2.1, 12)
    assert.equal(playback.drains(), 0)
    playback.quietFrom(3.3, 5)
    assert.equal(playback.drains(), 1)
    playback.sample(4)
    assert.equal(playback.drains(), 1)
})

test("silent or unobserved input cannot confirm a playout drain", () => {
    const playback = fixture()
    playback.watch.generationCompleted()
    playback.quietFrom(1, 30)
    assert.equal(playback.drains(), 0)
    playback.sample(4.1, 0.05)
    playback.quietFrom(4.2, 9)
    playback.sample(null)
    playback.sample(10)
    assert.equal(playback.drains(), 0)
    playback.quietFrom(10.1, 15)
    assert.equal(playback.drains(), 1)
})

test("sample gaps and resumed speech restart the quiet window", () => {
    const playback = fixture()
    playback.watch.generationCompleted()
    playback.sample(1, 0.05)
    playback.quietFrom(1.1, 10)
    playback.sample(4)
    assert.equal(playback.drains(), 0)
    playback.quietFrom(4.1, 10)
    playback.sample(5.1, 0.05)
    playback.quietFrom(5.2, 10)
    assert.equal(playback.drains(), 0)
    playback.watch.stop()
    playback.quietFrom(6.2, 30)
    assert.equal(playback.drains(), 0)
})
