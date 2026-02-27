"use client"

import React, { createContext, useContext, useState, FC, PropsWithChildren } from "react"
import { v4 as uuidv4 } from "uuid"
import { BackendSource, LoggedEvent } from "@/app/types"

type EventContextValue = {
    loggedEvents: LoggedEvent[]
    logClientEvent: (eventObj: Record<string, any>, eventNameSuffix?: string, sourceBackend?: BackendSource) => void
    logServerEvent: (eventObj: Record<string, any>, eventNameSuffix?: string, sourceBackend?: BackendSource) => void
    toggleExpand: (id: number | string) => void
}

const EventContext = createContext<EventContextValue | undefined>(undefined)

export const EventProvider: FC<PropsWithChildren> = ({ children }) => {
    const [loggedEvents, setLoggedEvents] = useState<LoggedEvent[]>([])

    function addLoggedEvent(
        direction: "client" | "server",
        eventName: string,
        eventData: Record<string, any>,
        sourceBackend: BackendSource,
    ) {
        const id = eventData.event_id || uuidv4()

        if (eventName === "response.audio_transcript.delta" || eventName === "response.function_call_arguments.delta") {
            // console.log("Skipping logging of response.audio_transcript.delta event")
        }

        setLoggedEvents((prev) => {
            if (prev.some((e) => e.id === id)) return prev // Avoid duplicates
            return [
                ...prev,
                {
                    id,
                    direction,
                    eventName,
                    eventData,
                    timestamp: new Date().toLocaleTimeString(),
                    expanded: false,
                    sourceBackend,
                },
            ]
        })
    }

    const logClientEvent: EventContextValue["logClientEvent"] = (
        eventObj,
        eventNameSuffix = "",
        sourceBackend = "realtime",
    ) => {
        const name = `${eventObj.type || ""} ${eventNameSuffix || ""}`.trim()
        addLoggedEvent("client", name, eventObj, sourceBackend)
    }

    const logServerEvent: EventContextValue["logServerEvent"] = (
        eventObj,
        eventNameSuffix = "",
        sourceBackend = "realtime",
    ) => {
        const name = `${eventObj.type || ""} ${eventNameSuffix || ""}`.trim()
        addLoggedEvent("server", name, eventObj, sourceBackend)
    }

    const toggleExpand: EventContextValue["toggleExpand"] = (id) => {
        setLoggedEvents((prev) =>
            prev.map((log) => {
                if (log.id === id) {
                    return { ...log, expanded: !log.expanded }
                }
                return log
            }),
        )
    }

    return (
        <EventContext.Provider value={{ loggedEvents, logClientEvent, logServerEvent, toggleExpand }}>
            {children}
        </EventContext.Provider>
    )
}

export function useEvent() {
    const context = useContext(EventContext)
    if (!context) {
        window.elasticApm?.captureError("useEvent must be used within an EventProvider")
        throw new Error("useEvent must be used within an EventProvider")
    }
    return context
}
