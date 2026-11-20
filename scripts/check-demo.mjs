#!/usr/bin/env node

// Run against the intended deployment; never print session tokens or upstream error bodies.
const argument = process.argv[2]
let base
try {
    base = new URL(argument)
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error("Invalid URL")
    }
} catch {
    console.error("Usage: node scripts/check-demo.mjs https://your-deployment.example")
    process.exit(2)
}

let failures = 0
const safeTitle = (title) =>
    title
        .replace(/\b(?:sk-[a-zA-Z0-9_-]{10,}|ek_[a-zA-Z0-9_-]{10,}|(?:ApiKey|Bearer)\s+[^\s"<>]+)/g, "[redacted]")
        .replace(/\p{C}/gu, " ")
        .replace(/\s+/g, " ")
        .slice(0, 110)

async function check(label, path, method, validate) {
    let status = "unavailable"
    try {
        const response = await fetch(new URL(path, base), {
            method,
            headers: {
                Accept: path === "/" ? "text/html" : "application/json",
                ...(process.env.DEMO_PASSWORD
                    ? { Authorization: `Basic ${Buffer.from(`demo:${process.env.DEMO_PASSWORD}`).toString("base64")}` }
                    : {}),
            },
            signal: AbortSignal.timeout(30000),
            cache: "no-store",
        })
        status = response.status
        if (status !== 200) {
            await response.body?.cancel()
            throw new Error("Unexpected HTTP status")
        }
        const detail = await validate(response)
        console.log(`PASS ${label} HTTP=${status}${detail ? ` ${detail}` : ""}`)
    } catch {
        failures += 1
        console.error(`FAIL ${label} HTTP=${status}`)
    }
}

await check("homepage", "/", "GET", async (response) => {
    if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("Expected HTML")
    await response.body?.cancel()
})

await check("realtime session", "/api/session", "POST", async (response) => {
    const data = await response.json()
    if (
        typeof data.value !== "string" ||
        !data.value.trim() ||
        typeof data.expires_at !== "number" ||
        data.expires_at <= Date.now() / 1000 ||
        typeof data.model !== "string" ||
        !data.model.trim()
    ) {
        throw new Error("Invalid session shape")
    }
})

const searches = [
    ["Elastic", "elasticsearch", "How does semantic search work in Elasticsearch?"],
    ["VA", "va", "How do veterans apply for health care benefits?"],
    ["Medicare", "medicare", "When can I enroll in Medicare?"],
    ["IRS", "irs", "How do I file a federal income tax return?"],
    ["BioGuide", "bioguide", "Abraham Lincoln"],
]
for (const [label, endpoint, query] of searches) {
    await check(`${label} search`, `/api/${endpoint}?q=${encodeURIComponent(query)}`, "GET", async (response) => {
        const data = await response.json()
        if (
            !Array.isArray(data.results) ||
            !data.results.length ||
            !data.results.every(
                (result) =>
                    result &&
                    typeof result.title === "string" &&
                    typeof result.body_content === "string" &&
                    result.body_content.trim().length &&
                    (result.url === null || typeof result.url === "string") &&
                    Array.isArray(result.additional_urls),
            )
        ) {
            throw new Error("Expected nonempty normalized search results")
        }
        return `count=${data.results.length} title=${safeTitle(data.results[0].title)}`
    })
}

console.log(`${failures ? "FAIL" : "PASS"} demo checks: ${7 - failures}/7 passed`)
process.exitCode = failures ? 1 : 0
