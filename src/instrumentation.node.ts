import os from "os"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"

type OtelRuntimeState = {
    sdk: NodeSDK | null
    metricReader: PeriodicExportingMetricReader | null
    started: boolean
    shutdownRegistered: boolean
}

const OTEL_STATE_KEY = "__realtimeOtelRuntimeState"

declare global {
    var __realtimeOtelRuntimeState: OtelRuntimeState | undefined
}

function debugLog(...args: unknown[]) {
    if (process.env.OTEL_LOG_LEVEL === "debug") {
        console.log("[otel]", ...args)
    }
}

const runtimeState =
    (globalThis as typeof globalThis & Record<string, OtelRuntimeState | undefined>)[OTEL_STATE_KEY] ||
    ((globalThis as typeof globalThis & Record<string, OtelRuntimeState | undefined>)[OTEL_STATE_KEY] = {
        sdk: null,
        metricReader: null,
        started: false,
        shutdownRegistered: false,
    })

async function shutdownSDK() {
    if (!runtimeState.sdk) {
        return
    }

    try {
        await runtimeState.metricReader?.forceFlush()
        await runtimeState.sdk.shutdown()
    } catch (error) {
        console.warn("Warning: error shutting down OTel SDK", error)
    } finally {
        runtimeState.sdk = null
        runtimeState.metricReader = null
        runtimeState.started = false
    }
}

if (!runtimeState.started) {
    const metricReader = new PeriodicExportingMetricReader({
        exportIntervalMillis: 60000,
        exporter: new OTLPMetricExporter({ timeoutMillis: 30000 }),
    })

    const sdk = new NodeSDK({
        logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ timeoutMillis: 30000 }) })],
        metricReaders: [metricReader],
        instrumentations: [new HttpInstrumentation()],
        spanProcessors: [
            new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: 10000 }), {
                scheduledDelayMillis: 3000,
                maxExportBatchSize: 200,
                exportTimeoutMillis: 10000,
            }),
        ],
    })

    runtimeState.sdk = sdk
    runtimeState.metricReader = metricReader
    runtimeState.started = true

    try {
        sdk.start()
    } catch (error) {
        console.error("Failed to start OTel SDK:", error)
    }
    debugLog("OpenTelemetry NodeSDK initialized")
}

if (!runtimeState.shutdownRegistered) {
    process.on("SIGTERM", async () => {
        await shutdownSDK()
        process.exit(128 + os.constants.signals.SIGTERM)
    })

    process.once("beforeExit", async () => {
        await shutdownSDK()
    })

    runtimeState.shutdownRegistered = true
}
