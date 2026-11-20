/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

function fixture() {
    let scheduled
    let sample = null
    let drains = 0
    let wallTime = 0
    const { watchWebRtcPlayback } = load("src/app/lib/webrtcMicrophoneGate.ts", {
        globals: {
            setTimeout(callback) { scheduled = callback; return 1 },
            clearTimeout() { scheduled = undefined },
            performance: { now: () => wallTime },
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
        advance(ms) { wallTime += ms },
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
    playback.quietFrom(2.1, 21)
    assert.equal(playback.drains(), 0)
    playback.quietFrom(4.2, 5)
    assert.equal(playback.drains(), 1)
    playback.sample(5)
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
    playback.quietFrom(10.1, 24)
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

test("only recent live decoded audio can extend the fixed drain watchdog", () => {
    const playback = fixture()
    assert.equal(playback.watch.hasRecentPlayback(), false)
    playback.sample(1, 0.05)
    assert.equal(playback.watch.hasRecentPlayback(), true)
    playback.advance(400)
    assert.equal(playback.watch.hasRecentPlayback(), false)
    playback.sample(2, 0.05)
    playback.sample(2, 0.05)
    assert.equal(playback.watch.hasRecentPlayback(), false)
})

test("internal 1 to 2 second pauses after generation finish do not release WebRTC playback", () => {
    for (const duration of [1, 1.5, 2]) {
        const playback = fixture()
        playback.sample(1, 0.05)
        playback.watch.generationCompleted()
        playback.quietFrom(1.1, Math.round(duration / 0.1))
        assert.equal(playback.drains(), 0, `internal pause of ${duration}s`)
        playback.sample(1.1 + duration, 0.05)
        assert.equal(playback.drains(), 0)
        playback.quietFrom(1.2 + duration, 25)
        assert.equal(playback.drains(), 1)
    }
})
