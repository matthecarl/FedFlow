import { NextResponse } from "next/server"
import { InvalidRequestError, readRequestObject } from "@/app/lib/request-json"

type TranscriptMessage = { role: "user" | "assistant"; title: string }

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
    if (!value || typeof value !== "object") return false
    const { role, title } = value as Partial<TranscriptMessage>
    return (role === "user" || role === "assistant") && typeof title === "string" && title.length <= 12000
}

export async function POST(request: Request) {
    if (!process.env.ZAP_URL) {
        return NextResponse.json({ error: "Email delivery is not configured." }, { status: 503 })
    }

    let eventData: Record<string, unknown>
    try {
        eventData = await readRequestObject(request, 100_000)
    } catch (error) {
        const status = error instanceof InvalidRequestError ? error.status : 400
        return NextResponse.json({ error: status === 413 ? "Email payload is too large." : "Invalid JSON payload." }, { status })
    }

    const { email, message } = eventData
    if (
        typeof email !== "string" ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !Array.isArray(message) ||
        message.length === 0 ||
        message.length > 200 ||
        !message.every(isTranscriptMessage)
    ) {
        return NextResponse.json(
            { error: "Provide a valid email address and conversation transcript." },
            { status: 400 },
        )
    }

    try {
        const transcript = message.map(({ role, title }) => ({ role, title }))
        const response = await fetch(process.env.ZAP_URL, {
            method: "POST",
            body: JSON.stringify({ email, message: transcript }),
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(15000),
            redirect: "error",
        })
        if (!response.ok) {
            console.error("Email webhook returned status:", response.status)
            return NextResponse.json({ error: "Email delivery failed. Please try again." }, { status: 502 })
        }
        return NextResponse.json({ result: "success" })
    } catch {
        return NextResponse.json({ error: "Email delivery is unavailable. Please try again." }, { status: 502 })
    }
}
