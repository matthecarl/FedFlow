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
    // Require demo access for handoffs, voice credentials, email, and telemetry
    // even when the rest of the app is public.
    const { pathname } = request.nextUrl
    const requiresAccess = pathname.startsWith("/api/support/")
        || /^\/api\/(?:session(?:\/gateway)?|sendEmail|telemetry)\/?$/.test(pathname)
    if (requiresAccess || process.env.DEMO_PASSWORD_ENABLED !== "false") {
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
    if (pathname.startsWith("/api/")) {
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
    // The SDK's queue callback uses Vercel's consumer authentication. Keep all
    // app routes and unused Workflow webhook paths behind the demo gate.
    matcher: "/((?!\\.well-known/workflow/v1/flow/?$).*)",
}
