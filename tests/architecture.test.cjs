/* global require, __dirname */
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")
const load = require("./helpers/load-typescript.cjs")

function renderTranscript(item) {
    const file = path.resolve(__dirname, "../src/app/components/Transcript.tsx")
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const dependencies = {
        react: React,
        "react/jsx-runtime": require("react/jsx-runtime"),
        "next/image": require("next/image"),
        "react-markdown": { default: () => { throw new Error("Architecture rendering must not depend on model Markdown") } },
        "@/app/contexts/TranscriptContext": { useTranscript: () => ({ transcriptItems: [item], toggleTranscriptItemExpand() {} }) },
        "@/app/lib/transcript-links": { remarkTranscriptLinks: () => { throw new Error("Architecture rendering must not depend on transcript links") } },
        "./Events": { redactEventData: (_key, value) => value },
    }
    const context = { exports: {}, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name] } }
    vm.runInNewContext(source, context, { filename: file })
    return renderToStaticMarkup(React.createElement(context.exports.default, { userText: "", setUserText() {}, onSendMessage() {}, canSend: false }))
}

test("showArchitecture displays the bundled diagram without assistant Markdown or expanded diagnostics", async () => {
    const greeter = load("src/app/agentConfigs/semanticSearch/greeter.ts").default
    const data = await greeter.toolLogic.showArchitecture({}, [])
    assert.equal(data.type, "display_image")
    assert.equal(data.src, "/architecture.png")
    assert.ok(fs.existsSync(path.resolve(__dirname, "../public", data.src.slice(1))))
    const html = renderTranscript({ itemId: "diagram", type: "BREADCRUMB", title: "Function result: showArchitecture", data, expanded: false, isHidden: false })
    assert.match(html, /<img[^>]+alt="Application architecture diagram"/)
    assert.match(html, /href="\/architecture.png"/)
    assert.match(html, /Application architecture<\/figcaption>/)
    assert.ok(!html.includes("only render") && !html.includes("qutoes"))
})

test("unrecognized image URLs cannot become rendered tool-result images", () => {
    const html = renderTranscript({ itemId: "diagram", type: "BREADCRUMB", title: "Function result: showArchitecture", data: { type: "display_image", src: "https://example.test/tracker.png" }, expanded: false, isHidden: false })
    assert.ok(!html.includes("tracker.png"))
    assert.ok(!html.includes("<figcaption"))
})
