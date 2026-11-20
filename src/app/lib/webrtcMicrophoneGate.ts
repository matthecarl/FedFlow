export type WebRtcPlaybackWatch = {
    generationCompleted: () => void
    stop: () => void
}

type PlaybackSample = { time: number; duration: number; rms: number }
const DRAIN_SAMPLE_MS = 75
const DRAIN_QUIET_SECONDS = 1.4
const AUDIBLE_RMS = 0.004
const QUIET_RMS = 0.0015

/** Detect a quiet tail only after observing the reply's audio and generation completion. */
export function watchWebRtcPlayback(readSample: () => PlaybackSample | null, onDrained: () => void): WebRtcPlaybackWatch {
    let doneGenerating = false
    let heardReply = false
    let stopped = false
    let quietSince: number | undefined
    let previousTime: number | undefined
    let timer: ReturnType<typeof setTimeout>

    const stop = () => {
        stopped = true
        clearTimeout(timer)
    }
    const poll = () => {
        if (stopped) return
        const sample = readSample()
        if (!sample || (previousTime !== undefined && sample.time <= previousTime)) {
            quietSince = undefined
        } else {
            if (sample.rms >= AUDIBLE_RMS) heardReply = true
            if (doneGenerating && heardReply && sample.rms <= QUIET_RMS) {
                // Gaps larger than the sampled window provide no evidence of
                // continuous quiet, such as when Chrome throttles a hidden tab.
                if (quietSince === undefined || previousTime === undefined || sample.time - previousTime > sample.duration) {
                    quietSince = sample.time
                }
                if (sample.time - quietSince >= DRAIN_QUIET_SECONDS) {
                    stop()
                    onDrained()
                    return
                }
            } else quietSince = undefined
            previousTime = sample.time
        }
        timer = setTimeout(poll, DRAIN_SAMPLE_MS)
    }
    timer = setTimeout(poll, DRAIN_SAMPLE_MS)
    return {
        stop,
        generationCompleted() {
            doneGenerating = true
            quietSince = undefined
        },
    }
}

export type WebRtcMicrophoneGate = {
    track: MediaStreamTrack
    hold: () => void
    release: (discard?: boolean) => void
    setRemotePlaybackStream: (stream: MediaStream) => void
    watchPlayback: (onDrained: () => void) => WebRtcPlaybackWatch
    close: () => void
}

/** Preserve the caller's microphone input without exposing it to upstream VAD during a reply. */
export async function createWebRtcMicrophoneGate(
    stream: MediaStream,
    signal: AbortSignal,
    onBufferedSpeech?: () => void,
): Promise<WebRtcMicrophoneGate> {
    signal.throwIfAborted()
    const audio = new AudioContext()
    const destination = audio.createMediaStreamDestination()
    destination.channelCount = 1
    const track = destination.stream.getAudioTracks()[0]
    let source: MediaStreamAudioSourceNode | undefined
    let gate: AudioWorkletNode | undefined
    let playbackSource: MediaStreamAudioSourceNode | undefined
    let playbackAnalyser: AnalyserNode | undefined
    let playbackTrack: MediaStreamTrack | undefined
    let playbackSamples: Float32Array<ArrayBuffer> | undefined
    let playbackWatch: WebRtcPlaybackWatch | undefined
    let closed = false
    let holding = false

    const close = () => {
        if (closed) return
        closed = true
        gate?.port.close()
        gate?.disconnect()
        source?.disconnect()
        playbackWatch?.stop()
        playbackSource?.disconnect()
        playbackAnalyser?.disconnect()
        track.stop()
        stream.getTracks().forEach((inputTrack) => inputTrack.stop())
        void audio.close().catch(() => {})
    }
    signal.addEventListener("abort", close, { once: true })
    try {
        await audio.audioWorklet.addModule("/fedflow-microphone.worklet.js")
        signal.throwIfAborted()
        source = audio.createMediaStreamSource(stream)
        gate = new AudioWorkletNode(audio, "fedflow-microphone", {
            channelCount: 1,
            channelCountMode: "explicit",
            outputChannelCount: [1],
        })
        const port = gate.port
        port.onmessage = ({ data }) => {
            if (!closed && data === "speech-buffered") onBufferedSpeech?.()
        }
        source.connect(gate).connect(destination)
        await audio.resume()
        signal.throwIfAborted()
        return {
            track,
            hold() {
                if (closed || holding) return
                holding = true
                port.postMessage("hold")
            },
            release(discard = false) {
                if (closed || (!holding && !discard)) return
                holding = false
                port.postMessage(discard ? "discard" : "release")
            },
            setRemotePlaybackStream(remoteStream) {
                const remoteTrack = remoteStream.getAudioTracks()[0]
                if (playbackTrack && playbackTrack !== remoteTrack) playbackWatch?.stop()
                playbackSource?.disconnect()
                playbackAnalyser?.disconnect()
                playbackSource = undefined
                playbackAnalyser = undefined
                playbackTrack = remoteTrack
                if (closed || !playbackTrack) return
                try {
                    const analyser = audio.createAnalyser()
                    analyser.fftSize = 8192
                    playbackSource = audio.createMediaStreamSource(remoteStream)
                    playbackSource.connect(analyser)
                    playbackAnalyser = analyser
                    playbackSamples = new Float32Array(analyser.fftSize)
                } catch {
                    // The SDP/data-channel path remains usable if the browser
                    // cannot expose decoded remote audio for observation.
                }
            },
            watchPlayback(onDrained) {
                playbackWatch?.stop()
                playbackWatch = watchWebRtcPlayback(() => {
                    if (audio.state !== "running" || playbackTrack?.readyState !== "live" || playbackTrack.muted ||
                        !playbackAnalyser || !playbackSamples) return null
                    playbackAnalyser.getFloatTimeDomainData(playbackSamples)
                    let energy = 0
                    for (const sample of playbackSamples) energy += sample * sample
                    return {
                        time: audio.currentTime,
                        duration: playbackSamples.length / audio.sampleRate,
                        rms: Math.sqrt(energy / playbackSamples.length),
                    }
                }, onDrained)
                return playbackWatch
            },
            close,
        }
    } catch (error) {
        close()
        throw error
    } finally {
        signal.removeEventListener("abort", close)
    }
}
