import { createHmac, timingSafeEqual } from "node:crypto"

const MAX_BODY_BYTES = 32 * 1024
export const RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1000
const RECEIPT_CONTEXT = "fedflow-handoff-receipt:v1:"
const START_CONTEXT = "fedflow-handoff-start:v1:"
const START_INPUT_CONTEXT = "fedflow-handoff-start-input:v1:"

export type HandoffInput = {
    question: string
    transcript: string
}

export class HandoffRequestError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message)
    }
}

export async function readHandoffInput(request: Request): Promise<HandoffInput> {
    const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    if (mediaType !== "application/json") {
        throw new HandoffRequestError("Submit a JSON transcript and question.", 415)
    }
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
        throw new HandoffRequestError("The transcript submission is too large.", 413)
    }
    if (!request.body) throw new HandoffRequestError("Provide a transcript and question.")

    let decoded = ""
    let size = 0
    const reader = request.body.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let data: unknown
    try {
        for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY_BYTES) {
                await reader.cancel().catch(() => undefined)
                throw new HandoffRequestError("The transcript submission is too large.", 413)
            }
            decoded += decoder.decode(value, { stream: true })
        }
        data = JSON.parse(decoded + decoder.decode())
    } catch (error) {
        if (error instanceof HandoffRequestError) throw error
        throw new HandoffRequestError("The transcript submission is not valid JSON.")
    } finally {
        reader.releaseLock()
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new HandoffRequestError("Provide a transcript and question.")
    }
    const { question, transcript } = data as Partial<HandoffInput>
    if (typeof question !== "string" || !question.trim() || question.length > 600) {
        throw new HandoffRequestError("Enter a question of 1–600 characters.")
    }
    if (typeof transcript !== "string" || !transcript.trim() || transcript.length > 4000) {
        throw new HandoffRequestError("Enter a transcript excerpt of 1–4,000 characters.")
    }
    return { question: question.trim(), transcript: transcript.trim() }
}

export function getReceiptSecret(): string | undefined {
    const secret = process.env.HANDOFF_RECEIPT_SECRET
    return secret && secret.trim().length >= 32 ? secret : undefined
}

export function startReservation(request: Request, input: HandoffInput, secret: string) {
    const key = request.headers.get("idempotency-key")
    if (key === null) return undefined
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
        throw new HandoffRequestError("The handoff submission key is invalid.")
    }

    // Claim one atomic slot per browser key and persist only a fingerprint of the draft.
    const token = START_CONTEXT + createHmac("sha256", secret).update(START_CONTEXT).update(key.toLowerCase()).digest("base64url")
    const payload = JSON.stringify([input.question, input.transcript])
    const fingerprint = createHmac("sha256", secret).update(START_INPUT_CONTEXT).update(payload).digest("base64url")
    return { token, fingerprint }
}

function receiptSignature(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(RECEIPT_CONTEXT).update(payload).digest("base64url")
}

// The shared demo login is not a per-reviewer identity. A signed receipt scopes
// reads to the browser that submitted the run, for a fixed period.
export function issueReceipt(runId: string, secret: string, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ runId, expiresAt: now + RECEIPT_LIFETIME_MS })).toString("base64url")
    return `${payload}.${receiptSignature(payload, secret)}`
}

export function verifyReceipt(receipt: string, secret: string, now = Date.now()): string | null {
    const parts = /^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(receipt)
    if (!parts) return null
    const [, payload, signature] = parts
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(receiptSignature(payload, secret)))) return null

    try {
        const { runId, expiresAt } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
        if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) return null
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + RECEIPT_LIFETIME_MS) return null
        return runId
    } catch {
        return null
    }
}
