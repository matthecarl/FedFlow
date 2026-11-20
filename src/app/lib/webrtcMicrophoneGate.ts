export type WebRtcMicrophoneGate = {
    track: MediaStreamTrack
    hold: () => void
    release: (discard?: boolean) => void
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
    let closed = false
    let holding = false

    const close = () => {
        if (closed) return
        closed = true
        gate?.port.close()
        gate?.disconnect()
        source?.disconnect()
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
            close,
        }
    } catch (error) {
        close()
        throw error
    } finally {
        signal.removeEventListener("abort", close)
    }
}
