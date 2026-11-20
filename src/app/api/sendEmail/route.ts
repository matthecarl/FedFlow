import { NextResponse } from "next/server"

export async function POST(request: Request) {
    if (!process.env.ZAP_URL) {
        return NextResponse.json({ error: "Email delivery is not configured." }, { status: 503 })
    }

    let eventData: unknown
    try {
        const payload = await request.text()
        if (payload.length > 100000) {
            return NextResponse.json({ error: "Email payload is too large." }, { status: 413 })
        }
        eventData = JSON.parse(payload)
    } catch {
        return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 })
    }

    if (!eventData || typeof eventData !== "object") {
        return NextResponse.json({ error: "Invalid email payload." }, { status: 400 })
    }
    const { email, message } = eventData as Record<string, unknown>
    if (
        typeof email !== "string" ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !Array.isArray(message) ||
        message.length === 0 ||
        message.length > 200 ||
        !message.every(
            (item) =>
                item &&
                typeof item === "object" &&
                (item.role === "user" || item.role === "assistant") &&
                typeof item.title === "string" &&
                item.title.length <= 12000,
        )
    ) {
        return NextResponse.json(
            { error: "Provide a valid email address and conversation transcript." },
            { status: 400 },
        )
    }

    try {
        const response = await fetch(process.env.ZAP_URL, {
            method: "POST",
            body: JSON.stringify({ email, message }),
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
