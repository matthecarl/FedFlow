import { Client } from "@elastic/elasticsearch"
import type { estypes } from "@elastic/elasticsearch"
import { NextRequest, NextResponse } from "next/server"

interface SearchDocument {
    id?: string
    usCongressBioId?: string
    title?: string
    body?: string
    body_content?: string
    url?: string
    additional_urls?: string[]
    profileText?: string
    bioDisplayName?: string
    givenName?: string
    middleName?: string
    familyName?: string
}

type SearchResult = estypes.SearchResponse<SearchDocument>

function extractBodyContentAndUrls(data: SearchResult) {
    const regexToRemove =
        /Skip to Content\s*An official website of the United States government\s*Here’s how you know\s*The \.gov means it’s official\..*?Talk to the Veterans Crisis Line now\s*/gs

    return data.hits.hits.map((hit) => {
        const source = hit._source ?? {}
        const fragments = Object.values(hit.highlight ?? {}).flat()
        const content = fragments.length
            ? fragments.join("\n\n")
            : (source.body_content ?? source.body ?? source.profileText ?? "")
        return {
            source_id: source.id ?? hit._id ?? null,
            ...(source.usCongressBioId ? { bioguide_id: source.usCongressBioId } : {}),
            title:
                source.title ??
                source.bioDisplayName ??
                [source.givenName, source.middleName, source.familyName].filter(Boolean).join(" "),
            body_content: content.replace(regexToRemove, "").trim().slice(0, 12000),
            url: source.url ?? source.additional_urls?.[0] ?? null,
            additional_urls: source.additional_urls ?? [],
        }
    })
}

let esClient: Client | undefined

function getSearchClient() {
    if (!esClient) {
        const node = process.env.ELASTICSEARCH_CAPSTONE_URL
        const apiKey = process.env.ELASTICSEARCH_CAPSTONE_API_KEY
        if (!node || !apiKey) throw new Error("Elasticsearch search is not configured")
        esClient = new Client({
            node,
            auth: { apiKey },
            requestTimeout: 20000,
            maxRetries: 0,
        })
    }
    return esClient
}

interface SearchOptions {
    index: string
    semanticField: string
    lexicalFields?: string[]
    nameFields?: string[]
    size?: number
}

// Query the public semantic_text interface, rather than its internal nested vector paths.
async function searchDocuments(
    query: string,
    { index, semanticField, lexicalFields, nameFields, size = 3 }: SearchOptions,
) {
    const sourceFields = [
        "id",
        "usCongressBioId",
        "title",
        "body",
        "body_content",
        "url",
        "additional_urls",
        "profileText",
        "bioDisplayName",
        "givenName",
        "middleName",
        "familyName",
    ]
    if (nameFields?.length) {
        // Prefer a person whose own name matches every term over biographies
        // that merely mention that person. Broader questions retain hybrid search.
        const nameMatches = await getSearchClient().search<SearchDocument>({
            index,
            size,
            _source: sourceFields,
            query: { multi_match: { query, fields: nameFields, type: "cross_fields", operator: "and" } },
        })
        if (nameMatches.hits.hits.length || nameMatches.timed_out || nameMatches._shards.failed) return nameMatches
    }
    const semantic = {
        standard: { query: { semantic: { field: semanticField, query } } },
    }
    const retriever = lexicalFields?.length
        ? {
              rrf: {
                  retrievers: [
                      {
                          standard: {
                              query: { multi_match: { query, fields: lexicalFields } },
                          },
                      },
                      semantic,
                  ],
                  rank_window_size: 10,
                  rank_constant: 1,
              },
          }
        : semantic
    return getSearchClient().search<SearchDocument>({
        index,
        size,
        retriever,
        _source: sourceFields,
        highlight: {
            fields: { [semanticField]: { number_of_fragments: 2, order: "score" } },
        },
    })
}

async function handleSearch(request: NextRequest, options: SearchOptions) {
    const query = request.nextUrl.searchParams.get("q")?.trim()
    if (!query || query.length > 2000) {
        return NextResponse.json({ error: "Provide a search query between 1 and 2000 characters." }, { status: 400 })
    }
    try {
        const result = await searchDocuments(query, options)
        if (result.timed_out || result._shards.failed) {
            return NextResponse.json({ error: "Search could not complete. Please try again." }, { status: 503 })
        }
        return NextResponse.json(
            { results: extractBodyContentAndUrls(result) },
            { headers: { "Cache-Control": "no-store" } },
        )
    } catch (error) {
        // Do not log the client error object: it can contain authorization headers.
        console.error(`Search unavailable for ${options.index}:`, error instanceof Error ? error.name : "UnknownError")
        return NextResponse.json({ error: "Search is temporarily unavailable. Please try again." }, { status: 503 })
    }
}

async function collectWebRTCStats(peerConnection: { getStats: () => any }) {
    const stats = await peerConnection.getStats()
    const statsReport: {
        type: any
        timestamp: any
        packetsLost: any
        jitter: any
        roundTripTime: any
        bitrate: any
    }[] = []

    stats.forEach(
        (report: {
            type: string
            timestamp: any
            packetsLost: any
            jitter: any
            roundTripTime: any
            bytesSent: any
            bytesReceived: any
        }) => {
            if (report.type === "inbound-rtp" || report.type === "outbound-rtp") {
                statsReport.push({
                    type: report.type,
                    timestamp: report.timestamp,
                    packetsLost: report.packetsLost,
                    jitter: report.jitter,
                    roundTripTime: report.roundTripTime,
                    bitrate: report.bytesSent || report.bytesReceived,
                })
            }
        },
    )
    try {
        console.log("Sending statsReport:", statsReport)
        const response = await fetch("/api/webrtc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stats: statsReport }),
        })

        // Log failure details if the response is not OK
        if (!response.ok) {
            console.warn("Telemetry request failed:", response.status, await response.text())
        }
    } catch (error) {
        console.error("Error sending telemetry:", error)
    }
    return statsReport
}

export type { SearchResult }
export { handleSearch, extractBodyContentAndUrls, collectWebRTCStats }
