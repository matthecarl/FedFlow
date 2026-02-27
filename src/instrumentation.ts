// OpenTelemetry instrumentation registration for Next.js
// This file is auto-imported by Next.js when instrumentation is enabled

/**
 * Registers OpenTelemetry instrumentation when running in a Node.js environment
 *
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") {
        return
    }

    if (process.env.NODE_ENV === "production" || process.env.ENABLE_OTEL === "true") {
        try {
            await import("./instrumentation.node")
        } catch (error) {
            console.error("Failed to load OpenTelemetry instrumentation:", error)
        }
    }
}
