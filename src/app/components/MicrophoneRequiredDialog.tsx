"use client"

import { useEffect, useRef } from "react"

export default function MicrophoneRequiredDialog({ onRetry, onSample }: { onRetry: () => void; onSample: () => void }) {
    const dialogRef = useRef<HTMLDialogElement>(null)

    useEffect(() => {
        const dialog = dialogRef.current
        const preventDismiss = (event: Event) => event.preventDefault()
        const preventEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") event.preventDefault()
        }
        dialog?.addEventListener("cancel", preventDismiss)
        dialog?.addEventListener("keydown", preventEscape)
        dialog?.showModal()
        return () => {
            dialog?.removeEventListener("cancel", preventDismiss)
            dialog?.removeEventListener("keydown", preventEscape)
            dialog?.close()
        }
    }, [])

    return (
        <dialog
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="microphone-required-title"
            aria-describedby="microphone-required-description"
            className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-3xl border border-red-200 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/80 backdrop:backdrop-blur-sm sm:p-10"
        >
            <p className="text-sm font-bold uppercase tracking-widest text-red-700">Microphone access required</p>
            <h1 id="microphone-required-title" className="mt-3 text-3xl font-bold leading-tight sm:text-4xl">
                Enable your microphone for the call.
            </h1>
            <p id="microphone-required-description" className="mt-5 text-lg leading-relaxed">
                Realtime calls need microphone access, including when you type into the call. You can draft a handoff from a sample call without it.
            </p>
            <ol className="mt-6 list-decimal space-y-3 pl-6 text-base leading-relaxed">
                <li>If a microphone permission prompt is open, choose <strong>Allow</strong>.</li>
                <li>If you blocked access, open this site&apos;s permissions in your browser and set <strong>Microphone</strong> to <strong>Allow</strong>. Also allow microphone access for your browser in your device settings.</li>
                <li>Reconnect below, then allow microphone access when asked.</li>
            </ol>
            <p className="mt-5 text-sm text-slate-600">Refreshing alone does not clear a saved denial. If access is already allowed, check that a microphone is connected and available.</p>
            <div className="mt-8 flex flex-col gap-3">
                <button className="btn btn-primary w-full justify-center" onClick={onRetry}>
                    I&apos;ve enabled my microphone — reconnect
                </button>
                <button className="btn btn-soft w-full justify-center" onClick={onSample}>Try sample call</button>
            </div>
        </dialog>
    )
}
