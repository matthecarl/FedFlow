import { getRun, start } from "workflow/api"
import { draftSupportHandoff, type HandoffResult } from "@/app/workflows/support-handoff"
import { getReceiptSecret, HandoffRequestError, issueReceipt, readHandoffInput, verifyReceipt } from "./request"

const headers = { "Cache-Control": "private, no-store" }
const unavailable = "The handoff service is temporarily unavailable."

function respond(body: object, status = 200) {
    return Response.json(body, { status, headers })
}

export async function POST(request: Request) {
    const secret = getReceiptSecret()
    if (!secret) return respond({ error: unavailable }, 503)

    try {
        const input = await readHandoffInput(request)
        const run = await start(draftSupportHandoff, [input])
        return respond({ receipt: issueReceipt(run.runId, secret) }, 202)
    } catch (error) {
        if (error instanceof HandoffRequestError) return respond({ error: error.message }, error.status)
        return respond({ error: unavailable }, 503)
    }
}

export async function GET(request: Request) {
    const secret = getReceiptSecret()
    if (!secret) return respond({ error: unavailable }, 503)

    const receipt = request.headers.get("x-fedflow-receipt") ?? ""
    const runId = verifyReceipt(receipt, secret)
    if (!runId) return respond({ error: "The handoff receipt is invalid or expired." }, 404)

    try {
        const run = getRun<HandoffResult>(runId)
        const status = await run.status
        if (status === "completed") return respond({ status: "complete", result: await run.returnValue })
        if (status === "failed" || status === "cancelled") {
            return respond({ status: "failed", error: "The draft could not be completed. Try the handoff again." })
        }
        return respond({ status: "pending" })
    } catch {
        return respond({ error: unavailable }, 503)
    }
}
