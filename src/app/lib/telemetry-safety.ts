// Keep credentials out of persisted events even when transcript capture is enabled.
const SECRET_FIELD = /authorization|api.?key|password|secret|access.?token|session.?token|cookie/i
const CONTENT_FIELD =
    /^(?:content|transcript|transcriptPreview|transcriptFull|message|messages|prompt|completion|input|output|text|text_chunk|message_content|arguments|params|results)$/i

export function sanitizeTelemetry(value: unknown, captureContent = false, depth = 0): unknown {
    if (depth > 12) return "[truncated]"
    if (typeof value === "string") {
        return value
            .replace(/\b(?:sk-[a-zA-Z0-9_-]{10,}|ek_[a-zA-Z0-9_-]{10,}|(?:ApiKey|Bearer)\s+[^\s"<>]+)/g, "[redacted]")
            .slice(0, 12000)
    }
    if (Array.isArray(value))
        return value.slice(0, 100).map((item) => sanitizeTelemetry(item, captureContent, depth + 1))
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, 200)
                .filter(
                    ([key]) =>
                        !SECRET_FIELD.test(key) &&
                        (captureContent || !CONTENT_FIELD.test(key.split(".").at(-1) ?? key)),
                )
                .map(([key, item]) => [key, sanitizeTelemetry(item, captureContent, depth + 1)]),
        )
    }
    return value
}
