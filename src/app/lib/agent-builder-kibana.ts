const DEFAULT_AGENT_ID = "elastic-ai-agent"

export function asOptionalNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export function asNonEmptyStringOrNull(value: unknown): string | null {
    return asOptionalNonEmptyString(value) ?? null
}

export function resolveAuthorizationHeader(): string {
    const apiKey = process.env.KIBANA_API_KEY?.trim()
    if (apiKey) {
        return apiKey.startsWith("ApiKey ") ? apiKey : `ApiKey ${apiKey}`
    }

    const username = process.env.KIBANA_USERNAME?.trim()
    const password = process.env.KIBANA_PASSWORD?.trim()

    if (username && password) {
        const encodedCredentials = Buffer.from(`${username}:${password}`).toString("base64")
        return `Basic ${encodedCredentials}`
    }

    throw new Error("Kibana authentication is not configured. Set KIBANA_API_KEY or KIBANA_USERNAME/KIBANA_PASSWORD.")
}

export function deriveKibanaUrlFromElasticsearchUrl(): string | null {
    const elasticsearchUrl = process.env.ELASTICSEARCH_CAPSTONE_URL?.trim()
    if (!elasticsearchUrl) {
        return null
    }

    try {
        const parsedUrl = new URL(elasticsearchUrl)
        if (!parsedUrl.hostname.includes(".es.")) {
            return null
        }

        parsedUrl.hostname = parsedUrl.hostname.replace(".es.", ".kb.")
        return parsedUrl.origin
    } catch {
        return null
    }
}

export function resolveConverseUrl(): string {
    const kibanaUrl = process.env.KIBANA_URL?.trim() || deriveKibanaUrlFromElasticsearchUrl()
    if (!kibanaUrl) {
        throw new Error(
            "Kibana URL is not configured. Set KIBANA_URL, or ELASTICSEARCH_CAPSTONE_URL with an .es. hostname for auto-derivation.",
        )
    }

    const normalizedBaseUrl = kibanaUrl.replace(/\/+$/, "")
    const spaceId = process.env.KIBANA_SPACE_ID?.trim()

    if (spaceId) {
        return `${normalizedBaseUrl}/s/${encodeURIComponent(spaceId)}/api/agent_builder/converse/async`
    }

    return `${normalizedBaseUrl}/api/agent_builder/converse/async`
}

export function resolveMappedAgentId(realtimeAgentName?: string): {
    mappedAgentId: string
    mappedFromRealtimeAgent?: string
} {
    const defaultAgentId = process.env.AGENT_BUILDER_AGENT_ID?.trim() || DEFAULT_AGENT_ID

    if (!realtimeAgentName) {
        return { mappedAgentId: defaultAgentId }
    }

    const mapString = process.env.AGENT_BUILDER_AGENT_MAP_JSON?.trim()
    if (!mapString) {
        return {
            mappedAgentId: defaultAgentId,
            mappedFromRealtimeAgent: realtimeAgentName,
        }
    }

    try {
        const parsedMap = JSON.parse(mapString)
        if (!parsedMap || typeof parsedMap !== "object" || Array.isArray(parsedMap)) {
            return {
                mappedAgentId: defaultAgentId,
                mappedFromRealtimeAgent: realtimeAgentName,
            }
        }

        const directMatch = (parsedMap as Record<string, unknown>)[realtimeAgentName]
        if (typeof directMatch === "string" && directMatch.trim().length > 0) {
            return {
                mappedAgentId: directMatch.trim(),
                mappedFromRealtimeAgent: realtimeAgentName,
            }
        }

        const normalizedName = realtimeAgentName.toLowerCase()
        for (const [mapKey, mapValue] of Object.entries(parsedMap as Record<string, unknown>)) {
            if (mapKey.toLowerCase() === normalizedName && typeof mapValue === "string" && mapValue.trim()) {
                return {
                    mappedAgentId: mapValue.trim(),
                    mappedFromRealtimeAgent: realtimeAgentName,
                }
            }
        }
    } catch {
        // Fall through to default agent id.
    }

    return {
        mappedAgentId: defaultAgentId,
        mappedFromRealtimeAgent: realtimeAgentName,
    }
}

export class InvalidRequestError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message)
    }
}

export async function readRequestObject(request: Request, maxLength = 100000): Promise<Record<string, unknown>> {
    const raw = await request.text()
    if (raw.length > maxLength) throw new InvalidRequestError("Request body is too large.", 413)
    let body: unknown
    try {
        body = JSON.parse(raw)
    } catch {
        throw new InvalidRequestError("Invalid JSON request.")
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
        throw new InvalidRequestError("Expected a JSON object.")
    return body as Record<string, unknown>
}
