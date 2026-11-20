import { useEffect, useRef, useState } from "react"
import type { TranscriptItem } from "@/app/types"

const API = "/api/support/handoffs"
const RECEIPT_KEY = "fedflow.handoff.receipt"
export const HANDOFF_QUESTION_LIMIT = 600
export const HANDOFF_TRANSCRIPT_LIMIT = 4000

export const supportPrompts = [
    { label: "Combine keyword and semantic search", question: "How can I combine keyword and semantic search in Elasticsearch using reciprocal rank fusion?" },
    { label: "When to use ELSER", question: "What is ELSER, and when should I use it for semantic search?" },
] as const

export type HandoffDraft = { question: string; transcript: string }

type HandoffResult = {
    status: "grounded" | "insufficient_evidence"
    summary: string
    nextStep: string
    sources: { id: string; title: string; url: string }[]
    usage?: { model: string; inputTokens?: number; outputTokens?: number; costUsd?: string; latencyMs?: number }
}

type HandoffRun =
    | { status: "idle" | "starting" }
    | { status: "pending"; receipt: string }
    | { status: "complete"; receipt: string; result: HandoffResult }
    | { status: "paused"; receipt: string; error: string }
    | { status: "failed"; error: string }

const sampleDraft: HandoffDraft = {
    question: supportPrompts[0].question,
    transcript: "Caller: Keyword search works for exact product names, but it misses questions phrased in everyday language. How can I combine keyword and semantic search in Elasticsearch using reciprocal rank fusion?\n\nSpecialist: You want the next engineer to recommend a hybrid retrieval approach and point to relevant Elastic documentation. The team can test it on a small set of representative queries.",
}

export function draftFromTranscript(items: TranscriptItem[]): HandoffDraft | null {
    // A new call starts a new transcript excerpt, while the screen keeps prior turns visible.
    const lastAgentStart = items.findLastIndex((item) => item.type === "BREADCRUMB" && item.title === "Agent: Elastic" && item.sourceBackend === "realtime")
    const turns = items.slice(lastAgentStart + 1).flatMap((item) => {
        if (item.type !== "MESSAGE" || item.isHidden || item.status !== "DONE" || item.sourceBackend !== "realtime") return []
        if (item.role !== "user" && item.role !== "assistant") return []
        const text = item.title?.trim()
        if (!text || text === "[inaudible]" || text === "[Transcribing...]") return []
        return [{ role: item.role, text }]
    })
    const caller = turns.findLastIndex((turn) => turn.role === "user")
    if (caller === -1) return null

    // Bound turns separately so a long specialist reply cannot displace the caller's question.
    const excerpt = turns.slice(Math.max(0, caller - 3), caller + 3).map(({ role, text }) => {
        const clipped = text.length > 650 ? `${text.slice(0, 649)}…` : text
        return `${role === "user" ? "Caller" : "Specialist"}: ${clipped}`
    })
    return {
        question: turns[caller].text.slice(0, HANDOFF_QUESTION_LIMIT),
        transcript: excerpt.join("\n\n").slice(0, HANDOFF_TRANSCRIPT_LIMIT),
    }
}

function rememberReceipt(receipt?: string) {
    try {
        if (receipt) sessionStorage.setItem(RECEIPT_KEY, receipt)
        else sessionStorage.removeItem(RECEIPT_KEY)
    } catch {
        // Storage can be disabled. The in-memory run still works on this page.
    }
}

function responseError(body: { error?: unknown } | null, fallback: string) {
    return body && typeof body.error === "string" ? body.error : fallback
}

export function useSupportHandoff(items: TranscriptItem[]) {
    const [open, setOpen] = useState(false)
    const [sample, setSample] = useState(false)
    const [draft, setDraft] = useState<HandoffDraft>({ question: "", transcript: "" })
    const [run, setRun] = useState<HandoffRun>({ status: "idle" })
    const [formError, setFormError] = useState("")
    const submission = useRef<AbortController | null>(null)
    const pendingReceipt = run.status === "pending" ? run.receipt : null

    useEffect(() => {
        try {
            const receipt = sessionStorage.getItem(RECEIPT_KEY)
            if (receipt) {
                setRun({ status: "pending", receipt })
                setOpen(true)
            }
        } catch {
            // Opening and submitting a new draft remain available.
        }
        return () => submission.current?.abort()
    }, [])

    useEffect(() => {
        if (!pendingReceipt) return
        const receipt = pendingReceipt
        const controller = new AbortController()
        const deadline = Date.now() + 90000
        let timer: ReturnType<typeof setTimeout> | undefined

        async function check() {
            try {
                const response = await fetch(API, {
                    cache: "no-store",
                    headers: { "X-FedFlow-Receipt": receipt },
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
                })
                const body = await response.json().catch(() => null)
                if (controller.signal.aborted) return
                if ([400, 404, 410].includes(response.status)) {
                    rememberReceipt()
                    setRun({ status: "failed", error: responseError(body, "This handoff link expired. Start a new draft to continue.") })
                } else if (!response.ok) {
                    setRun({ status: "paused", receipt, error: responseError(body, "Could not check the handoff. Try again to resume this run.") })
                } else if (body?.status === "complete" && body.result) {
                    setRun({ status: "complete", receipt, result: body.result })
                } else if (body?.status === "failed") {
                    rememberReceipt()
                    setRun({ status: "failed", error: responseError(body, "The handoff did not finish. Check the source service and try again.") })
                } else if (body?.status === "pending" && Date.now() < deadline) {
                    timer = setTimeout(check, 1500)
                } else {
                    setRun({ status: "paused", receipt, error: "The handoff is taking longer than expected. Check again to resume this run." })
                }
            } catch {
                if (!controller.signal.aborted) {
                    setRun({ status: "paused", receipt, error: "Could not reach the handoff service. Try again to resume this run." })
                }
            }
        }

        void check()
        return () => {
            controller.abort()
            clearTimeout(timer)
        }
    }, [pendingReceipt])

    const liveDraft = draftFromTranscript(items)
    const busy = run.status === "starting" || run.status === "pending"

    function openDraft(nextDraft: HandoffDraft, isSample: boolean) {
        if (!busy && !submission.current) {
            setFormError("")
            rememberReceipt()
            setDraft(nextDraft)
            setSample(isSample)
            setRun({ status: "idle" })
        }
        setOpen(true)
    }

    async function submit() {
        if (submission.current) return
        if (!draft.question.trim() || !draft.transcript.trim()) return
        setFormError("")
        setRun({ status: "starting" })
        const controller = new AbortController()
        submission.current = controller
        try {
            const response = await fetch(API, {
                method: "POST",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: draft.question.trim(), transcript: draft.transcript.trim() }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            })
            const body = await response.json().catch(() => null)
            if (controller.signal.aborted) return
            if (!response.ok || typeof body?.receipt !== "string") {
                throw new Error(responseError(body, "Could not start the handoff. Try again."))
            }
            rememberReceipt(body.receipt)
            setRun({ status: "pending", receipt: body.receipt })
        } catch (error) {
            if (!controller.signal.aborted) {
                setFormError(error instanceof Error && error.name !== "TimeoutError" ? error.message : "The handoff service did not respond. Try again.")
                setRun({ status: "idle" })
            }
        } finally {
            submission.current = null
        }
    }

    return {
        open,
        sample,
        draft,
        setDraft,
        run,
        formError,
        canDraft: Boolean(liveDraft),
        hasRun: run.status !== "idle",
        close: () => setOpen(false),
        view: () => setOpen(true),
        openSample: () => openDraft(sampleDraft, true),
        openCall: () => { if (liveDraft) openDraft(liveDraft, false) },
        submit,
        resume: () => { if (run.status === "paused") setRun({ status: "pending", receipt: run.receipt }) },
        edit: () => setRun({ status: "idle" }),
    }
}
