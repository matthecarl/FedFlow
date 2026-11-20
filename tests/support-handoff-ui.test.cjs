/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const load = require("./helpers/load-typescript.cjs")

const { draftFromTranscript, supportPrompts } = load("src/app/hooks/useSupportHandoff.ts", { dependencies: { react: {} } })
const message = (role, title, fields = {}) => ({ role, title, type: "MESSAGE", status: "DONE", isHidden: false, ...fields })
const bioGuideStart = { type: "BREADCRUMB", title: "Agent: BioGuide" }
const researchQuestion = supportPrompts[0].question

test("the reviewed excerpt stays within the current call and excludes hidden or unfinished turns", () => {
    const draft = draftFromTranscript([
        message("user", "Previous call"),
        bioGuideStart,
        message("user", "Simulated greeting", { isHidden: true }),
        message("user", researchQuestion),
        message("assistant", "I’ll check the official congressional biography."),
        message("user", "[Transcribing...]", { status: "IN_PROGRESS" }),
    ])
    assert.equal(draft.question, "What congressional offices did John Quincy Adams hold, and when?")
    assert.equal(draft.transcript, `Caller: ${researchQuestion}\n\nSpecialist: I’ll check the official congressional biography.`)
    assert.equal(draftFromTranscript([
        bioGuideStart,
        message("user", researchQuestion),
        { type: "BREADCRUMB", title: "Agent: Elastic" },
        message("user", "How does semantic search work?"),
    ]), null)
})

test("a long specialist answer preserves the caller's question inside the backend limits", () => {
    const draft = draftFromTranscript([
        bioGuideStart,
        message("user", `${researchQuestion} ${"x".repeat(3000)}`),
        message("assistant", "y".repeat(6000)),
    ])
    assert.equal(draft.question.length, 600)
    assert.ok(draft.transcript.length <= 4000)
    assert.ok(draft.transcript.startsWith(`Caller: ${researchQuestion}`))
    assert.equal(draftFromTranscript([bioGuideStart, message("user", "[inaudible]")]), null)
})
