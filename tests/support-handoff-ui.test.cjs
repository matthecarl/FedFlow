/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

const { draftFromTranscript } = load("src/app/hooks/useSupportHandoff.ts", { dependencies: { react: {} } })
const message = (role, title, fields = {}) => ({ role, title, type: "MESSAGE", status: "DONE", isHidden: false, ...fields })

test("the reviewed excerpt stays within the current call and excludes hidden or unfinished turns", () => {
    const draft = draftFromTranscript([
        message("user", "Previous call"),
        { type: "BREADCRUMB", title: "Agent: Elastic" },
        message("user", "Simulated greeting", { isHidden: true }),
        message("user", "Can we combine keyword and semantic search?"),
        message("assistant", "We can consider reciprocal rank fusion."),
        message("user", "[Transcribing...]", { status: "IN_PROGRESS" }),
    ])
    assert.equal(draft.question, "Can we combine keyword and semantic search?")
    assert.equal(draft.transcript, "Caller: Can we combine keyword and semantic search?\n\nSpecialist: We can consider reciprocal rank fusion.")
})

test("a long specialist answer preserves the caller's question inside the backend limits", () => {
    const draft = draftFromTranscript([
        message("user", `Explain ELSER ${"x".repeat(3000)}`),
        message("assistant", "y".repeat(6000)),
    ])
    assert.equal(draft.question.length, 600)
    assert.ok(draft.transcript.length <= 4000)
    assert.ok(draft.transcript.startsWith("Caller: Explain ELSER"))
    assert.equal(draftFromTranscript([message("user", "[inaudible]")]), null)
})
