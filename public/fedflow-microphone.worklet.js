// Keep enough room for a caller to start speaking during a complete reply.
const MAX_BUFFER_SECONDS = 60
const SPEECH_RMS = 0.004
const SPEECH_SECONDS = 0.025
const PREROLL_SECONDS = 0.3
const VAD_TAIL_SECONDS = 0.6

class FedFlowMicrophone extends AudioWorkletProcessor {
    constructor() {
        super()
        this.buffer = new Float32Array(Math.floor(sampleRate * MAX_BUFFER_SECONDS))
        this.preRoll = Math.floor(sampleRate * PREROLL_SECONDS)
        this.tail = Math.floor(sampleRate * VAD_TAIL_SECONDS)
        this.read = 0
        this.write = 0
        this.firstVoice = -1
        this.lastVoice = -1
        this.voiceFrames = 0
        this.notified = false
        this.holding = false
        this.replaying = false

        this.port.onmessage = ({ data }) => {
            if (data === "hold") {
                this.holding = true
                if (this.notified) this.port.postMessage("speech-buffered")
            } else if (data === "discard") {
                this.holding = false
                this.reset()
            } else if (data === "release" && this.holding) {
                this.holding = false
                if (this.firstVoice < 0) {
                    this.reset()
                } else {
                    this.read = Math.max(this.read, this.firstVoice - this.preRoll)
                    this.replaying = true
                }
            }
        }
    }

    reset() {
        this.read = 0
        this.write = 0
        this.firstVoice = -1
        this.lastVoice = -1
        this.voiceFrames = 0
        this.notified = false
        this.replaying = false
    }

    capture(input, length) {
        let energy = 0
        for (let i = 0; i < length; i++) {
            const sample = input?.[i] ?? 0
            energy += sample * sample
            this.buffer[this.write % this.buffer.length] = sample
            this.write++
        }
        if (energy >= length * SPEECH_RMS * SPEECH_RMS) {
            if (this.firstVoice < 0) this.firstVoice = this.write - length
            this.lastVoice = this.write - 1
            this.voiceFrames += length
            if (this.holding && !this.notified && this.voiceFrames >= sampleRate * SPEECH_SECONDS) {
                this.notified = true
                this.port.postMessage("speech-buffered")
            }
        }
        this.read = Math.max(this.read, this.write - this.buffer.length)
    }

    process(inputs, outputs) {
        const input = inputs[0]?.[0]
        const output = outputs[0]?.[0]
        if (!output) return true

        if (!this.holding && !this.replaying) {
            if (input) output.set(input)
            return true
        }
        this.capture(input, output.length)
        if (this.holding) return true

        // Preserve the tail long enough for server VAD to commit, then drop the
        // remaining queued silence so ordinary speech returns to live latency.
        for (let i = 0; i < output.length; i++) {
            output[i] = this.buffer[this.read % this.buffer.length]
            this.read++
        }
        if (this.read >= this.lastVoice + this.tail || this.read === this.write) this.reset()
        return true
    }
}

registerProcessor("fedflow-microphone", FedFlowMicrophone)
