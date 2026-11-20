import { NextResponse } from "next/server"
import { Client } from "@elastic/elasticsearch"
import { InvalidRequestError, readRequestObject } from "@/app/lib/request-json"
import { sanitizeTelemetry } from "@/app/lib/telemetry-safety"

let esClient: Client | undefined

export async function POST(request: Request) {
    const esNode = process.env.ELASTICSEARCH_CAPSTONE_URL
    const esApiKey = process.env.ELASTICSEARCH_LOGSAI_API_KEY
    if (!esNode || !esApiKey) {
        return NextResponse.json({ error: "WebRTC telemetry is not configured." }, { status: 503 })
    }

    try {
        const eventData = sanitizeTelemetry(await readRequestObject(request, 64000)) as Record<string, unknown>
        esClient ??= new Client({ node: esNode, auth: { apiKey: esApiKey }, requestTimeout: 10000, maxRetries: 0 })
        await esClient.index({
            index: "webrtc-stats",
            op_type: "create",
            document: { ...eventData, "@timestamp": new Date().toISOString() },
        })
        return NextResponse.json({ result: "success" })
    } catch (error) {
        if (error instanceof InvalidRequestError) {
            return NextResponse.json({ error: error.message }, { status: error.status })
        }
        console.error("WebRTC telemetry indexing failed")
        return NextResponse.json({ error: "WebRTC telemetry could not be stored." }, { status: 502 })
    }
}
