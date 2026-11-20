/* global require */
const test = require("node:test")
const assert = require("node:assert/strict")
const { createElement } = require("react")
const { renderToStaticMarkup } = require("react-dom/server")
const load = require("./helpers/load-typescript.cjs")

const { remarkTranscriptLinks } = load("src/app/lib/transcript-links.ts", {
    dependencies: { linkifyjs: require("linkifyjs") },
})

async function render(markdown) {
    const { default: ReactMarkdown } = await import("react-markdown")
    return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkTranscriptLinks] }, markdown))
}

test("bare Medicare addresses become HTTPS links and keep sentence punctuation outside", async () => {
    const first = "medicare.gov/basics/get-started-with-medicare"
    const second = `${first}/sign-up/when-can-i-sign-up-for-medicare`
    const html = await render(`For full details, see ${first} or ${second}.`)
    assert.ok(html.includes(`<a href="https://${first}">${first}</a> or <a href="https://${second}">${second}</a>.`))
})

test("explicit web URLs keep their path, query, and fragment inside surrounding punctuation", async () => {
    const html = await render("Read (https://example.org/guide_(en)?x=1&y=2#topic), or www.irs.gov/forms.")
    assert.ok(html.includes('(<a href="https://example.org/guide_(en)?x=1&amp;y=2#topic">https://example.org/guide_(en)?x=1&amp;y=2#topic</a>),'))
    assert.ok(html.includes('<a href="https://www.irs.gov/forms">www.irs.gov/forms</a>.'))
})

test("Markdown links and inline code keep their original content", async () => {
    const html = await render("[medicare.gov](https://medicare.gov/benefits) and [irs.gov][tax] with `va.gov` and **usa.gov**.\n\n[tax]: https://irs.gov/forms")
    assert.ok(html.includes('<a href="https://medicare.gov/benefits">medicare.gov</a>'))
    assert.ok(html.includes('<a href="https://irs.gov/forms">irs.gov</a>'))
    assert.ok(html.includes('<code>va.gov</code>'))
    assert.ok(html.includes('<strong><a href="https://usa.gov/">usa.gov</a></strong>'))
    assert.equal((html.match(/<a /g) ?? []).length, 3)
})

test("bare link detection skips unsafe schemes, credentials, and email addresses", async () => {
    const html = await render("javascript:medicare.gov/path data:https://example.org ftp://irs.gov http://user:secret@va.gov help@medicare.gov")
    assert.ok(!html.includes("<a"))
    assert.ok(html.includes("javascript:medicare.gov/path"))
})
