export class InvalidRequestError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message)
    }
}

export async function readRequestObject(request: Request, maxLength: number): Promise<Record<string, unknown>> {
    const raw = await request.text()
    if (raw.length > maxLength) throw new InvalidRequestError("Request body is too large.", 413)
    let body: unknown
    try {
        body = JSON.parse(raw)
    } catch {
        throw new InvalidRequestError("Invalid JSON request.")
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
        throw new InvalidRequestError("Expected a JSON object.")
    return body as Record<string, unknown>
}
