import { getHookByToken, getRun, start } from "workflow/api"
import { HookConflictError, RunExpiredError, WorkflowRunNotFoundError } from "workflow/errors"
import { draftSupportHandoff, type HandoffResult } from "@/app/workflows/support-handoff"
import { getReceiptSecret, HandoffRequestError, issueReceipt, readHandoffInput, RECEIPT_LIFETIME_MS, startReservation, verifyReceipt } from "./request"

const headers = { "Cache-Control": "private, no-store" }
const unavailable = "The handoff service is temporarily unavailable."
const invalidReceipt = "The handoff receipt is invalid or expired."

function respond(body: object, status = 200) {
    return Response.json(body, { status, headers })
}

export async function POST(request: Request) {
    const secret = getReceiptSecret()
    if (!secret) return respond({ error: unavailable }, 503)

    try {
        const input = await readHandoffInput(request)
        const reservation = startReservation(request, input, secret)
        if (!reservation) {
            const run = await start(draftSupportHandoff, [input])
            return respond({ receipt: issueReceipt(run.runId, secret) }, 202)
        }

        const { token, fingerprint } = reservation
        const run = await start(draftSupportHandoff, [input], {
            // Keep the reservation past the receipt's lifetime even if admission takes time.
            experimental_hook: { token, metadata: fingerprint, experimental_minRetention: "25h" },
        }).catch(async (error: unknown) => {
            if (!HookConflictError.is(error) || error.kind !== "start" || !error.conflictingRunId) throw error
            const holder = await getHookByToken(token)
            if (holder.runId !== error.conflictingRunId) throw error
            if (await holder.metadata !== fingerprint) {
                throw new HandoffRequestError("This submission key belongs to a different draft. Review the excerpt and try again.", 409)
            }
            return getRun<HandoffResult>(error.conflictingRunId)
        })
        const admittedAt = (await run.createdAt).getTime()
        if (!Number.isFinite(admittedAt)) return respond({ error: unavailable }, 503)
        const now = Date.now()
        const createdAt = Math.min(now, admittedAt)
        if (createdAt + RECEIPT_LIFETIME_MS <= now) return respond({ error: invalidReceipt }, 404)
        return respond({ receipt: issueReceipt(run.runId, secret, createdAt) }, 202)
    } catch (error) {
        if (error instanceof HandoffRequestError) return respond({ error: error.message }, error.status)
        if (RunExpiredError.is(error)) return respond({ error: invalidReceipt }, 404)
        return respond({ error: unavailable }, 503)
    }
}

export async function GET(request: Request) {
    const secret = getReceiptSecret()
    if (!secret) return respond({ error: unavailable }, 503)

    const receipt = request.headers.get("x-fedflow-receipt") ?? ""
    const runId = verifyReceipt(receipt, secret)
    if (!runId) return respond({ error: invalidReceipt }, 404)

    try {
        const run = getRun<HandoffResult>(runId)
        const status = await run.status
        if (status === "completed") return respond({ status: "complete", result: await run.returnValue })
        if (status === "failed" || status === "cancelled") {
            return respond({ status: "failed", error: "The draft could not be completed. Try the handoff again." })
        }
        return respond({ status: "pending" })
    } catch (error) {
        if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return respond({ error: invalidReceipt }, 404)
        return respond({ error: unavailable }, 503)
    }
}
