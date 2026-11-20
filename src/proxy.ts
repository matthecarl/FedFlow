import { createHash, timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"

const privateHeaders = {
    "Cache-Control": "private, no-store, max-age=0",
    "Vercel-CDN-Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
}

// Hash both sides so comparison time does not reveal password length or prefix.
function matches(actual: string, expected: string): boolean {
    return timingSafeEqual(
        createHash("sha256").update(actual).digest(),
        createHash("sha256").update(expected).digest(),
    )
}

export function proxy(request: NextRequest) {
    // Only an explicit false disables the gate; absent or misspelled values stay protected.
    if (process.env.DEMO_PASSWORD_ENABLED !== "false") {
        const password = process.env.DEMO_PASSWORD
        if (!password || password.trim().length < 16) {
            return new NextResponse("Demo access is not configured.", {
                status: 503,
                headers: privateHeaders,
            })
        }
    
        const authorization = request.headers.get("authorization") || ""
        const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
        const supplied = basic ? Buffer.from(basic[1], "base64").toString("utf8") : ""
        if (!matches(supplied, `demo:${password}`)) {
            return new NextResponse("A demo username and password are required.", {
                status: 401,
                headers: {
                    ...privateHeaders,
                    "WWW-Authenticate": 'Basic realm="FedFlow demo", charset="UTF-8"',
                },
            })
        }
    }

    // Browsers cache Basic credentials. Do not let another website spend them
    // on API requests, including search GETs, even while the password gate is disabled.
    if (request.nextUrl.pathname.startsWith("/api/")) {
        const origin = request.headers.get("origin")
        if (
            request.headers.get("sec-fetch-site") === "cross-site" ||
            (origin && origin !== request.nextUrl.origin)
        ) {
            return new NextResponse("Cross-origin API requests are not allowed.", {
                status: 403,
                headers: privateHeaders,
            })
        }
    }

    // The password is only for this gate; downstream handlers must not log or
    // forward it to OpenAI, Elasticsearch, or telemetry.
    const headers = new Headers(request.headers)
    headers.delete("authorization")
    const response = NextResponse.next({ request: { headers } })
    for (const [name, value] of Object.entries(privateHeaders)) {
        response.headers.set(name, value)
    }
    return response
}

export const config = {
    matcher: "/:path*",
}
