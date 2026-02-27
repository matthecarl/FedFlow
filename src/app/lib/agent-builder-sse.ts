export interface ParsedSseFrame {
    event: string
    data: string
}

export interface SplitSseFramesResult {
    frames: string[]
    remaining: string
}

export function splitSseFrames(buffer: string): SplitSseFramesResult {
    const normalizedBuffer = buffer.replace(/\r\n/g, "\n")
    const parts = normalizedBuffer.split("\n\n")
    const remaining = parts.pop() ?? ""

    return {
        frames: parts.filter((frame) => frame.trim().length > 0),
        remaining,
    }
}

export function parseSseFrame(frame: string): ParsedSseFrame | null {
    const lines = frame.split("\n")
    let event = "message"
    const dataLines: string[] = []

    for (const line of lines) {
        if (!line) {
            continue
        }

        if (line.startsWith(":")) {
            continue
        }

        if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim() || "message"
            continue
        }

        if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart())
        }
    }

    if (dataLines.length === 0) {
        return null
    }

    return {
        event,
        data: dataLines.join("\n"),
    }
}

export function safeParseSseData(data: string): unknown {
    try {
        return JSON.parse(data)
    } catch {
        return data
    }
}
