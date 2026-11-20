type VoiceRouteConfig = {
    agent: string
    transport: "direct" | "gateway"
    model: string
    provider: string
    label: string
    voice?: string
    turnDetection?: "server-vad" | "semantic-vad"
}

export const VOICE_ROUTES = {
    greeter: {
        agent: "greeter",
        transport: "direct",
        model: "gpt-realtime-2.1-mini",
        provider: "OpenAI",
        label: "GPT Realtime 2.1 Mini",
    },
    IRS: {
        agent: "IRS",
        transport: "gateway",
        model: "elevenlabs/eleven-realtime-v1-max",
        provider: "ElevenLabs",
        label: "Eleven Realtime v1 Max",
        voice: "6WwXjDDEMyNmFG95zycZ",
        turnDetection: "semantic-vad",
    },
    VA: {
        agent: "VA",
        transport: "gateway",
        model: "google/gemini-3.8-live",
        provider: "Google",
        label: "Gemini 3.8 Live",
    },
    Medicare: {
        agent: "Medicare",
        transport: "gateway",
        model: "spacexai/grok-voice-3.0",
        provider: "xAI",
        label: "Grok Voice 3.0",
    },
    BioGuide: {
        agent: "BioGuide",
        transport: "gateway",
        model: "openai/gpt-realtime-2.1",
        provider: "OpenAI",
        label: "GPT Realtime 2.1",
    },
} as const satisfies Record<string, VoiceRouteConfig>

type DefinedRoute = (typeof VOICE_ROUTES)[keyof typeof VOICE_ROUTES]
export type VoiceRoute = DefinedRoute & Pick<VoiceRouteConfig, "voice" | "turnDetection">
export type GatewayVoiceRoute = Extract<VoiceRoute, { transport: "gateway" }>

export function getVoiceRoute(agent: string | null | undefined): VoiceRoute | undefined {
    if (!agent || !Object.hasOwn(VOICE_ROUTES, agent)) return undefined
    return VOICE_ROUTES[agent as keyof typeof VOICE_ROUTES]
}
