import { createGateway } from "ai"
import { getVoiceRoute } from "@/app/lib/voice-routes"

const headers = { "Cache-Control": "private, no-store, max-age=0" }
const serverError = "The selected voice session is temporarily unavailable."

function json(body: object, status: number) {
    return Response.json(body, { status, headers })
}

function isGatewaySocket(url: string, model: string): boolean {
    try {
        const socket = new URL(url)
        return socket.protocol === "wss:"
            && socket.hostname === "ai-gateway.vercel.sh"
            && !socket.username && !socket.password && !socket.port
            && socket.searchParams.get("ai-model-id") === model
    } catch {
        return false
    }
}

export async function POST(request: Request) {
    const params = new URL(request.url).searchParams
    const route = getVoiceRoute(params.get("agent"))
    if (params.size !== 1 || route?.transport !== "gateway") {
        return json({ error: "Select a supported Gateway voice agent." }, 400)
    }

    // Gateway requires an API key to mint browser tokens. The project's OIDC
    // credential can still serve text inference through the separate Workflow.
    const apiKey = process.env.AI_GATEWAY_REALTIME_API_KEY?.trim() || process.env.AI_GATEWAY_API_KEY?.trim()
    if (!apiKey) return json({ error: "AI Gateway voice is not configured." }, 503)

    try {
        // Ignore client-supplied model/session overrides. The route selects
        // the model and the SDK scopes the browser credential to that model.
        const gateway = createGateway({
            apiKey,
            fetch(input, init) {
                const signals = [request.signal, AbortSignal.timeout(15_000)]
                if (init?.signal) signals.push(init.signal)
                return fetch(input, { ...init, signal: AbortSignal.any(signals), cache: "no-store" })
            },
        })
        const { token, url, expiresAt } = await gateway.experimental_realtime.getToken({
            model: route.model,
            expiresAfterSeconds: 60,
        })
        if (typeof token !== "string" || !/^vcst_[A-Za-z0-9_.-]+$/.test(token) || !isGatewaySocket(url, route.model)) {
            return json({ error: serverError }, 502)
        }
        return json({ token, url, expiresAt, agent: route.agent, model: route.model, provider: route.provider }, 200)
    } catch (error) {
        // Never forward a Gateway error body, which can include request details.
        const upstream = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined
        if (upstream === 401 || upstream === 403) {
            return json({ error: "AI Gateway did not authorize this voice session." }, 503)
        }
        if (upstream === 429) return json({ error: "The voice service is busy. Try again shortly." }, 429)
        return json({ error: serverError }, 503)
    }
}
