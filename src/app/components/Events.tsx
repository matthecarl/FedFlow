"use client";

import React, { useRef, useEffect } from "react";
import { useEvent } from "@/app/contexts/EventContext";

export interface EventsProps {
  isExpanded: boolean;
}

// Never render credentials from session or diagnostic payloads.
export function redactEventData(_key: string, value: unknown): unknown {
  if (/^(authorization|api[_-]?key|token|access_token|client_secret|secret|password)$/i.test(_key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value.replace(/\b(?:sk-|ek[_-]|vcst_)[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  }
  return value;
}

function Events({ isExpanded }: EventsProps) {
  const lastEventIdRef = useRef<string | number | undefined>(undefined);
  const eventLogsContainerRef = useRef<HTMLDivElement | null>(null);

  const { loggedEvents, toggleExpand } = useEvent();

  const getDirectionArrow = (direction: string) => {
    if (direction === "client") return { symbol: "▲", color: "#0B64DD" };
    if (direction === "server") return { symbol: "▼", color: "#02BCB7" };
    return { symbol: "•", color: "#555" };
  };

  useEffect(() => {
    const latestEventId = loggedEvents.at(-1)?.id;

    if (isExpanded && latestEventId !== lastEventIdRef.current && eventLogsContainerRef.current) {
      eventLogsContainerRef.current.scrollTop =
        eventLogsContainerRef.current.scrollHeight;
    }

    lastEventIdRef.current = latestEventId;
  }, [loggedEvents, isExpanded]);

  return (
    <div className="events-panel card-solid">
      <div className="border-b border-slate-200 bg-white/70 px-4 py-3 backdrop-blur">
        <div className="text-sm font-semibold text-slate-900">Logs</div>
        <div className="mt-0.5 text-xs text-slate-600">
          Protocol events sent between client and server.
        </div>
        <p className="mt-1 text-xs text-slate-500 min-[1100px]:hidden">Turn off Logs below to return to the conversation.</p>
      </div>

      <div className="events-scroll" ref={eventLogsContainerRef}>
        <div>
          {loggedEvents.map((log) => {

            const arrowInfo = getDirectionArrow(log.direction);
            const isError =
              log.eventName.toLowerCase().includes("error") ||
              log.eventData?.response?.status_details?.error != null;

            return (
              <div key={log.id} className="border-t border-slate-200 px-4 py-2 font-mono">
                <button
                  type="button"
                  onClick={() => toggleExpand(log.id)}
                  className="flex w-full cursor-pointer items-start justify-between gap-2 text-left"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span style={{ color: arrowInfo.color }} className="mt-0.5 shrink-0">
                      {arrowInfo.symbol}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={"truncate text-sm " + (isError ? "text-red-600" : "text-slate-900")}>
                        {log.eventName}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">{log.timestamp}</div>
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-slate-500">{log.expanded ? "Hide" : "Show"}</div>
                </button>

                {log.expanded && log.eventData && (
                  <div className="mt-2 text-left text-slate-900">
                    <pre className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                      {JSON.stringify(log.eventData, redactEventData, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default Events;
