import { useEffect, useRef } from "react"
import {
    HANDOFF_QUESTION_LIMIT,
    HANDOFF_TRANSCRIPT_LIMIT,
    type useSupportHandoff,
} from "@/app/hooks/useSupportHandoff"

export function SupportHandoffDialog({ handoff }: { handoff: ReturnType<typeof useSupportHandoff> }) {
    const dialogRef = useRef<HTMLDialogElement>(null)
    const { open, close, run, draft, setDraft } = handoff

    useEffect(() => {
        const dialog = dialogRef.current
        if (open && !dialog?.open) dialog?.showModal()
        if (!open && dialog?.open) dialog.close()
    }, [open])

    return (
        <dialog
            ref={dialogRef}
            className="handoff-dialog"
            aria-labelledby="handoff-heading"
            onCancel={(event) => {
                event.preventDefault()
                close()
            }}
        >
            <div className="handoff-heading">
                <div className="min-w-0">
                    <h2 id="handoff-heading" className="font-mierb text-2xl leading-tight">Support handoff</h2>
                    <p className="mt-1 text-sm text-slate-600">A draft for the next engineer</p>
                </div>
                <button type="button" className="btn btn-soft shrink-0" onClick={close} aria-label="Close handoff">Close</button>
            </div>

            <div className="handoff-content">
                {(run.status === "idle" || run.status === "starting") && (
                    <form onSubmit={(event) => { event.preventDefault(); void handoff.submit() }} className="space-y-4">
                        <p className="text-sm leading-relaxed text-slate-600">
                            {handoff.sample ? "This sample uses a synthetic call excerpt. " : ""}
                            Review the question and remove any sensitive details before generating a draft.
                        </p>
                        <label className="block text-sm font-semibold text-slate-800">
                            Support question
                            <input className="control mt-1.5" value={draft.question} maxLength={HANDOFF_QUESTION_LIMIT} required
                                onChange={(event) => setDraft({ ...draft, question: event.target.value })} disabled={run.status === "starting"} />
                        </label>
                        <label className="block text-sm font-semibold text-slate-800">
                            Transcript excerpt
                            <textarea className="control mt-1.5 min-h-28 resize-y leading-relaxed" rows={5} value={draft.transcript}
                                maxLength={HANDOFF_TRANSCRIPT_LIMIT} required disabled={run.status === "starting"}
                                onChange={(event) => setDraft({ ...draft, transcript: event.target.value })} />
                        </label>
                        {handoff.formError && <p role="alert" className="handoff-warning">{handoff.formError}</p>}
                        <button type="submit" className="btn btn-primary" disabled={run.status === "starting" || !draft.question.trim() || !draft.transcript.trim()}>
                            {run.status === "starting" ? "Starting handoff…" : "Generate handoff"}
                        </button>
                    </form>
                )}

                {run.status === "pending" && (
                    <div role="status" className="handoff-notice">
                        <p className="font-semibold">Drafting handoff…</p>
                        <p className="mt-1 text-sm leading-relaxed">Checking the Elastic knowledge base. You can refresh this tab and return to the same draft.</p>
                    </div>
                )}

                {run.status === "paused" && (
                    <div className="space-y-3">
                        <p role="alert" className="handoff-warning">{run.error}</p>
                        <button type="button" className="btn btn-primary" onClick={handoff.resume}>Check again</button>
                    </div>
                )}

                {run.status === "failed" && (
                    <div className="space-y-3">
                        <p role="alert" className="handoff-warning">{run.error}</p>
                        {draft.question && draft.transcript
                            ? <button type="button" className="btn btn-primary" onClick={handoff.edit}>Edit draft and retry</button>
                            : <button type="button" className="btn btn-primary" onClick={handoff.openSample}>Try sample call</button>}
                    </div>
                )}

                {run.status === "complete" && (
                    <article className="space-y-4" aria-label="Completed support handoff">
                        <p role="status" className={run.result.status === "grounded" ? "handoff-notice font-semibold" : "handoff-warning font-semibold"}>
                            {run.result.status === "grounded" ? "Handoff ready to review" : "Insufficient evidence to recommend a fix"}
                        </p>
                        {run.result.summary && <section>
                            <h3 className="mb-1 font-semibold">Issue summary</h3>
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{run.result.summary}</p>
                        </section>}
                        {run.result.nextStep && <section>
                            <h3 className="mb-1 font-semibold">Suggested next step</h3>
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{run.result.nextStep}</p>
                        </section>}
                        {run.result.sources.length > 0 && <section className="border-t border-slate-200 pt-3">
                            <h3 className="font-semibold">Elastic sources</h3>
                            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                                {run.result.sources.filter((source) => source.url.startsWith("https://")).map((source) => (
                                    <li key={source.id}>
                                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-words font-semibold text-blue underline underline-offset-2">
                                            {source.title}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </section>}
                        {run.result.usage && <p className="border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-600">
                            {[
                                run.result.usage.model,
                                typeof run.result.usage.inputTokens === "number" ? `${run.result.usage.inputTokens} input tokens` : null,
                                typeof run.result.usage.outputTokens === "number" ? `${run.result.usage.outputTokens} output tokens` : null,
                                run.result.usage.costUsd ? `$${run.result.usage.costUsd} model cost` : null,
                                typeof run.result.usage.latencyMs === "number" ? `${(run.result.usage.latencyMs / 1000).toFixed(1)}s generation` : null,
                            ].filter(Boolean).join(" · ")}
                        </p>}
                    </article>
                )}
            </div>
        </dialog>
    )
}
