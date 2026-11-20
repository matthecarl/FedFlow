import { useEffect, useRef, useState } from "react"
import type { TranscriptItem } from "@/app/types"

const API = "/api/support/handoffs"
const RECEIPT_KEY = "fedflow.bioguide.handoff.receipt"
const SUBMISSION_KEY = "fedflow.bioguide.handoff.submission"
export const SUPPORT_AGENT = "BioGuide"
export const HANDOFF_QUESTION_LIMIT = 600
export const HANDOFF_TRANSCRIPT_LIMIT = 4000

export const supportPrompts = [
    { label: "John Quincy Adams’s congressional service", question: "What congressional offices did John Quincy Adams hold, and when?" },
    { label: "Shirley Chisholm’s House service", question: "When did Shirley Chisholm serve in the U.S. House of Representatives?" },
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
    transcript: `Caller: I’m checking a public biography for a reference request. ${supportPrompts[0].question}\n\nSpecialist: I’ll check the Biographical Directory of the United States Congress and include the source so the next researcher can verify the offices and dates.`,
}

export function draftFromTranscript(items: TranscriptItem[]): HandoffDraft | null {
    // Other specialists remain available, so draft only from the current BioGuide segment.
    const lastAgentStart = items.findLastIndex((item) => item.type === "BREADCRUMB" && item.title?.startsWith("Agent: "))
    if (items[lastAgentStart]?.title !== `Agent: ${SUPPORT_AGENT}`) return null
    const turns = items.slice(lastAgentStart + 1).flatMap((item) => {
        if (item.type !== "MESSAGE" || item.isHidden || item.status !== "DONE") return []
        if (item.role !== "user" && item.role !== "assistant") return []
        const text = item.title?.trim()
        if (!text || text === "[inaudible]" || text === "[Transcribing...]") return []
        return [{ role: item.role, text }]
    })
    const caller = turns.findLastIndex((turn) => turn.role === "user")
    if (caller === -1) return null

    // Bound turns separately so a long specialist reply cannot displace the caller's question.
    const callerText = turns[caller].text
    const handoffQuestion = items[lastAgentStart].data?.user_question
    const confirmedTransfer = typeof handoffQuestion === "string" && handoffQuestion.trim() &&
        !turns.slice(0, caller).some((turn) => turn.role === "user") &&
        /^(?:yes|yeah|correct|that['’]s (?:right|correct))(?:[, ]+(?:please|that['’]s (?:right|correct)))?[.!]?$/i.test(callerText)
    const question = confirmedTransfer ? handoffQuestion : callerText
    const excerpt = turns.slice(Math.max(0, caller - 3), caller + 3).map(({ role, text }) => {
        const clipped = text.length > 650 ? `${text.slice(0, 649)}…` : text
        return `${role === "user" ? "Caller" : "Specialist"}: ${clipped}`
    })
    if (confirmedTransfer) excerpt.unshift(`Caller: ${question.slice(0, HANDOFF_QUESTION_LIMIT)}`)
    return {
        question: question.slice(0, HANDOFF_QUESTION_LIMIT),
        transcript: excerpt.join("\n\n").slice(0, HANDOFF_TRANSCRIPT_LIMIT),
    }
}

function rememberHandoffValue(key: string, value?: string) {
    try {
        if (value) sessionStorage.setItem(key, value)
        else sessionStorage.removeItem(key)
    } catch {
        // Storage can be disabled. The in-memory run still works on this page.
    }
}

function rememberReceipt(receipt?: string) {
    rememberHandoffValue(RECEIPT_KEY, receipt)
}

function readSubmissionKey() {
    try {
        return sessionStorage.getItem(SUBMISSION_KEY)
    } catch {
        return null
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
    const submissionAttempt = useRef<{ key: string; body: string } | null>(null)
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
            const payload = JSON.stringify({ question: draft.question.trim(), transcript: draft.transcript.trim() })
            const previous = submissionAttempt.current
            let key = previous?.key ?? readSubmissionKey()
            if (!key || (previous && previous.body !== payload)) key = crypto.randomUUID()
            submissionAttempt.current = { key, body: payload }
            // Persist only the random key. Workflow stores the matching draft fingerprint.
            rememberHandoffValue(SUBMISSION_KEY, key)
            const response = await fetch(API, {
                method: "POST",
                cache: "no-store",
                headers: { "Content-Type": "application/json", "Idempotency-Key": key },
                body: payload,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            })
            const body = await response.json().catch(() => null)
            if (controller.signal.aborted) return
            if (response.status === 400 || response.status === 404 || response.status === 409) {
                submissionAttempt.current = null
                rememberHandoffValue(SUBMISSION_KEY)
            }
            if (!response.ok || typeof body?.receipt !== "string") {
                throw new Error(responseError(body, "Could not start the handoff. Try again."))
            }
            rememberReceipt(body.receipt)
            submissionAttempt.current = null
            rememberHandoffValue(SUBMISSION_KEY)
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
