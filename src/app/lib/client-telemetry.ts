/**
 * Client-side telemetry utility
 *
 * Canonical path is server-side OpenTelemetry ingestion via /api/telemetry.
 * During migration, RUM mirroring can remain enabled for dashboard continuity.
 */

import { ClientTelemetryEnvelope, TokenUsage } from "../types"
import * as semconv from "./semconv"
import { startTransaction, captureError } from "./apm-rum"

type TelemetryTransport = "server" | "rum" | "both"

function isBrowser(): boolean {
    return typeof window !== "undefined"
}

function normalizeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function getTransportMode(): TelemetryTransport {
    const raw = process.env.NEXT_PUBLIC_TELEMETRY_TRANSPORT?.toLowerCase()
    if (raw === "server" || raw === "rum" || raw === "both") {
        return raw
    }
    return "both"
}

function isRumMirrorEnabled(): boolean {
    return process.env.NEXT_PUBLIC_TELEMETRY_MIRROR_TO_RUM !== "false"
}

function shouldSendToServer(): boolean {
    const mode = getTransportMode()
    return mode === "server" || mode === "both"
}

function shouldSendToRum(): boolean {
    const mode = getTransportMode()
    if (mode === "rum" || mode === "both") {
        return true
    }

    return mode === "server" && isRumMirrorEnabled()
}

async function postTelemetry(eventType: string, eventData: Record<string, unknown>): Promise<void> {
    if (!isBrowser() || !shouldSendToServer()) {
        return
    }

    const envelope: ClientTelemetryEnvelope = {
        eventType,
        eventData,
        timestamp: new Date().toISOString(),
        schemaVersion: "v1",
    }

    const response = await fetch("/api/telemetry", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
        keepalive: true,
    })

    if (!response.ok) {
        const body = await response.text().catch(() => "")
        // Don't throw: Next dev overlay will show this as a "Console Error" and it distracts during demos.
        // We still log and mirror to RUM error capture so it's visible in observability tooling.
        const err = new Error(`Telemetry endpoint returned ${response.status}: ${body || response.statusText}`)
        console.warn(err.message)
        captureError(normalizeError(err), { tags: { source: "client-telemetry" } })
        return
    }
}

function mirrorRumTransaction(name: string, type: string, labels: Record<string, string | number | boolean>, error?: unknown): void {
    if (!isBrowser() || !shouldSendToRum()) {
        return
    }

    const transaction = startTransaction(name, type)
    if (!transaction) {
        return
    }

    transaction.addLabels(labels)
    if (error) {
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
    transaction.end()
}

export async function recordTokenUsage(usageData: TokenUsage, model?: string) {
    try {
        const eventData: Record<string, unknown> = {
            totalTokens: usageData.total_tokens,
            inputTokens: usageData.input_tokens,
            outputTokens: usageData.output_tokens,
            model: model || "unknown",
            input_token_details: usageData.input_token_details,
            output_token_details: usageData.output_token_details,
        }

        await postTelemetry("token_usage", eventData)

        mirrorRumTransaction("gen_ai.token_usage", "metrics", {
            [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
            [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
            [semconv.ATTR_GEN_AI_TOTAL_TOKENS]: usageData.total_tokens,
            [semconv.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usageData.input_tokens,
            [semconv.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usageData.output_tokens,
            [semconv.ATTR_GEN_AI_RESPONSE_MODEL]: model || "unknown",
        })
    } catch (error) {
        console.error("Error recording token usage:", error)
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
}

export async function recordResponseDoneDetails(responseData: any) {
    try {
        const output = responseData?.output?.[0] || {}
        const content = Array.isArray(output?.content) ? output.content : []
        const transcriptContent = content.find((c: any) => typeof c?.transcript === "string" && c.transcript.trim())
        const transcript = transcriptContent?.transcript || ""

        const eventData: Record<string, unknown> = {
            responseId: responseData?.id,
            responseStatus: responseData?.status,
            conversationId: responseData?.conversation_id,
            model: responseData?.model,
            voice: responseData?.voice,
            outputAudioFormat: responseData?.output_audio_format,
            temperature: responseData?.temperature,
            maxOutputTokens: responseData?.max_output_tokens,
            modalities: responseData?.modalities,
            outputItemId: output?.id,
            outputItemType: output?.type,
            outputItemStatus: output?.status,
            outputItemRole: output?.role,
            contentTypes: content.map((c: any) => c?.type).filter(Boolean),
            hasAudioContent: content.some((c: any) => c?.type === "audio"),
            hasTranscript: transcript.length > 0,
            transcriptLength: transcript.length,
            transcriptPreview: transcript.slice(0, 150),
        }

        await postTelemetry("response_details", eventData)

        mirrorRumTransaction("gen_ai.response_details", "app", {
            [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
            [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
            [semconv.ATTR_GEN_AI_RESPONSE_ID]: responseData?.id || "unknown",
            [semconv.ATTR_GEN_AI_RESPONSE_STATUS]: responseData?.status || "unknown",
            [semconv.ATTR_GEN_AI_CONVERSATION_ID]: responseData?.conversation_id || "unknown",
            [semconv.ATTR_GEN_AI_TRANSCRIPT_LENGTH]: transcript.length,
        })
    } catch (error) {
        console.error("Error recording response details:", error)
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
}

export async function recordToolCall(toolName: string, success: boolean, resultCount?: number, error?: any) {
    try {
        const eventData: Record<string, unknown> = {
            toolName,
            success,
            resultCount,
            error: error ? normalizeError(error) : undefined,
        }

        await postTelemetry("tool_call", eventData)

        mirrorRumTransaction(
            "gen_ai.tool_call",
            "app",
            {
                [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
                [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
                [semconv.ATTR_GEN_AI_TOOL_CALLED]: true,
                [semconv.ATTR_GEN_AI_TOOL_NAME]: toolName,
                [semconv.ATTR_GEN_AI_TOOL_SUCCESS]: success,
                ...(resultCount !== undefined ? { [semconv.ATTR_GEN_AI_TOOL_RESULT_COUNT]: resultCount } : {}),
            },
            error,
        )
    } catch (err) {
        console.error("Error recording tool call:", err)
        captureError(normalizeError(err), { tags: { source: "client-telemetry" } })
    }
}

export async function recordRealtimeFetch(
    url: string,
    method: string,
    statusCode?: number,
    error?: any,
    model?: string,
) {
    try {
        const eventData: Record<string, unknown> = {
            url,
            method,
            statusCode,
            error: error ? normalizeError(error) : undefined,
            model,
        }

        await postTelemetry("realtime_fetch", eventData)

        mirrorRumTransaction(
            "gen_ai.realtime_fetch",
            "external",
            {
                [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
                [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
                "http.url": url,
                "http.method": method,
                ...(statusCode ? { "http.status_code": statusCode } : {}),
                ...(model ? { [semconv.ATTR_GEN_AI_RESPONSE_MODEL]: model } : {}),
            },
            error,
        )
    } catch (err) {
        console.error("Error recording realtime fetch:", err)
        captureError(normalizeError(err), { tags: { source: "client-telemetry" } })
    }
}

export async function recordServerEvent(eventType: string, eventData: any) {
    try {
        const normalizedEventData: Record<string, unknown> = {
            ...eventData,
            sourceEventType: eventType,
            eventId: eventData?.eventId || eventData?.event_id,
            responseId: eventData?.responseId || eventData?.response_id,
            itemId: eventData?.itemId || eventData?.item_id,
            sessionId: eventData?.sessionId || eventData?.session_id,
            conversationId: eventData?.conversationId || eventData?.conversation_id,
            model: eventData?.model,
        }

        await postTelemetry(eventType, normalizedEventData)

        mirrorRumTransaction("gen_ai.server_event", "app", {
            [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
            [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
            [semconv.ATTR_GEN_AI_EVENT_TYPE]: eventType,
            ...(normalizedEventData.responseId ? { [semconv.ATTR_GEN_AI_RESPONSE_ID]: String(normalizedEventData.responseId) } : {}),
            ...(normalizedEventData.eventId ? { [semconv.ATTR_GEN_AI_EVENT_ID]: String(normalizedEventData.eventId) } : {}),
        })
    } catch (error) {
        console.error("Error recording server event:", error)
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
}

export async function recordFullTranscript(responseData: any) {
    try {
        const output = responseData?.output?.[0] || {}
        const content = Array.isArray(output?.content) ? output.content : []
        const transcriptContent = content.find((c: any) => typeof c?.transcript === "string" && c.transcript.trim())
        const transcript = transcriptContent?.transcript || ""

        if (!transcript) {
            return
        }

        const eventData: Record<string, unknown> = {
            responseId: responseData?.id,
            outputItemId: output?.id,
            status: responseData?.status,
            conversationId: responseData?.conversation_id,
            transcript,
            transcriptSource: "assistant",
            role: "assistant",
            timestamp: Date.now(),
        }

        await postTelemetry("full_transcript", eventData)

        mirrorRumTransaction("gen_ai.full_transcript", "app", {
            [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
            [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
            [semconv.ATTR_GEN_AI_RESPONSE_ID]: responseData?.id || "unknown",
            [semconv.ATTR_GEN_AI_TRANSCRIPT_LENGTH]: transcript.length,
            [semconv.ATTR_GEN_AI_TRANSCRIPT_ROLE]: "assistant",
        })
    } catch (error) {
        console.error("Error recording full transcript:", error)
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
}

export async function recordUserTranscript(event: any) {
    try {
        const transcript = event?.transcript || ""
        if (!transcript || transcript === "\n") {
            return
        }

        const eventData: Record<string, unknown> = {
            eventId: event?.event_id,
            itemId: event?.item_id,
            contentIndex: event?.content_index,
            transcript,
            timestamp: Date.now(),
            role: "user",
            transcriptSource: "user",
        }

        await postTelemetry("user_transcript", eventData)

        mirrorRumTransaction("gen_ai.user_transcript", "app", {
            [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
            [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
            [semconv.ATTR_GEN_AI_EVENT_ID]: event?.event_id || "unknown",
            [semconv.ATTR_GEN_AI_ITEM_ID]: event?.item_id || "unknown",
            [semconv.ATTR_GEN_AI_TRANSCRIPT_LENGTH]: transcript.length,
        })
    } catch (error) {
        console.error("Error recording user transcript:", error)
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
}

export async function recordCompleteDoneEvent(eventData: any) {
    try {
        await postTelemetry("response.done", eventData)

        const response = eventData?.response
        mirrorRumTransaction("gen_ai.response.done", "app", {
            [semconv.ATTR_GEN_AI_SYSTEM]: "openai",
            [semconv.ATTR_GEN_AI_OPERATION_NAME]: "realtime",
            [semconv.ATTR_GEN_AI_RESPONSE_ID]: response?.id || "unknown",
            [semconv.ATTR_GEN_AI_RESPONSE_STATUS]: response?.status || "unknown",
            [semconv.ATTR_GEN_AI_RESPONSE_MODEL]: response?.model || "unknown",
        })
    } catch (error) {
        console.error("Error recording complete done event:", error)
        captureError(normalizeError(error), { tags: { source: "client-telemetry" } })
    }
}
