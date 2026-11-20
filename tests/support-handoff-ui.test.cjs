/* global require, AbortController, Response */
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

test("a confirmed call transfer preserves the carried BioGuide question in the draft", () => {
    const transfer = { ...bioGuideStart, data: { user_question: researchQuestion } }
    const introduction = message("assistant", "I understand you’re asking about John Quincy Adams’s congressional service. Is that correct?")
    assert.equal(draftFromTranscript([transfer, introduction]), null)
    const draft = draftFromTranscript([transfer, introduction, message("user", "Yes, that's right.")])
    assert.equal(draft.question, researchQuestion)
    assert.ok(draft.transcript.startsWith(`Caller: ${researchQuestion}`))
})

test("the handoff form reuses its pending submission key after a lost response and a refresh", async () => {
    const values = new Map()
    const requests = []
    let generated = 0

    const createPage = () => {
        const states = []
        const refs = []
        let stateIndex = 0
        let refIndex = 0
        const { useSupportHandoff } = load("src/app/hooks/useSupportHandoff.ts", {
            dependencies: { react: {
                useEffect() {},
                useRef(initial) {
                    const index = refIndex++
                    return refs[index] ??= { current: initial }
                },
                useState(initial) {
                    const index = stateIndex++
                    if (!(index in states)) states[index] = initial
                    return [states[index], (value) => { states[index] = value }]
                },
            } },
            globals: {
                AbortController,
                sessionStorage: {
                    getItem: (key) => values.get(key) ?? null,
                    setItem: (key, value) => values.set(key, value),
                    removeItem: (key) => values.delete(key),
                },
                crypto: { randomUUID: () => `fixture-key-${++generated}` },
                async fetch(_path, options) {
                    requests.push(options)
                    if (requests.length === 1) throw new Error("Response lost")
                    return Response.json({ receipt: "fixture-receipt" }, { status: 202 })
                },
            },
        })
        return () => {
            refIndex = 0
            stateIndex = 0
            return useSupportHandoff([])
        }
    }

    const firstPage = createPage()
    firstPage().openSample()
    await firstPage().submit()
    assert.equal(firstPage().run.status, "idle")
    assert.deepEqual([...values.values()], ["fixture-key-1"])

    const refreshed = createPage()
    refreshed().openSample()
    await refreshed().submit()
    assert.equal(refreshed().run.status, "pending")
    assert.equal(requests[1].headers["Idempotency-Key"], requests[0].headers["Idempotency-Key"])
    assert.equal(requests[1].body, requests[0].body)
    assert.deepEqual([...values.values()], ["fixture-receipt"])
    assert.equal(generated, 1)
})
