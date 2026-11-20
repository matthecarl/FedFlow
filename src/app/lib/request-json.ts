export class InvalidRequestError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message)
    }
}

export async function readRequestObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
    if (Number(request.headers.get("content-length")) > maxBytes) {
        throw new InvalidRequestError("Request body is too large.", 413)
    }
    if (!request.body) throw new InvalidRequestError("Expected a JSON object.")

    const reader = request.body.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let raw = ""
    let bytes = 0
    let body: unknown
    try {
        for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => undefined)
                throw new InvalidRequestError("Request body is too large.", 413)
            }
            raw += decoder.decode(value, { stream: true })
        }
        body = JSON.parse(raw + decoder.decode())
    } catch (error) {
        if (error instanceof InvalidRequestError) throw error
        throw new InvalidRequestError("Invalid JSON request.")
    } finally {
        reader.releaseLock()
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
        throw new InvalidRequestError("Expected a JSON object.")
    return body as Record<string, unknown>
}
