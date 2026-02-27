"use client";

import React, { useRef, useEffect, useState } from "react";
import { useEvent } from "@/app/contexts/EventContext";
import { LoggedEvent } from "@/app/types";

export interface EventsProps {
  isExpanded: boolean;
}

function Events({ isExpanded }: EventsProps) {
  const [prevEventLogs, setPrevEventLogs] = useState<LoggedEvent[]>([]);
  const eventLogsContainerRef = useRef<HTMLDivElement | null>(null);

  const { loggedEvents, toggleExpand } = useEvent();

  const getDirectionArrow = (direction: string) => {
    if (direction === "client") return { symbol: "▲", color: "#0B64DD" };
    if (direction === "server") return { symbol: "▼", color: "#02BCB7" };
    return { symbol: "•", color: "#555" };
  };

  useEffect(() => {
    const hasNewEvent = loggedEvents.length > prevEventLogs.length;

    if (isExpanded && hasNewEvent && eventLogsContainerRef.current) {
      eventLogsContainerRef.current.scrollTop =
        eventLogsContainerRef.current.scrollHeight;
    }

    setPrevEventLogs(loggedEvents);
  }, [loggedEvents, isExpanded]);

  return (
    <div className="card-solid flex min-h-0 flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-white/70 px-4 py-3 backdrop-blur">
        <div className="text-sm font-semibold text-slate-900">Logs</div>
        <div className="mt-0.5 text-xs text-slate-600">
          Protocol events sent between client and server.
        </div>
      </div>

      <div className="min-h-0 overflow-auto" ref={eventLogsContainerRef}>
        <div>
          {loggedEvents.map((log) => {

            if (
              log.eventName === "response.audio_transcript.delta" ||
              log.eventName === "response.function_call_arguments.delta"
            ) {
              return null;
            }

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
                        {log.sourceBackend && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-500">
                            [{log.sourceBackend}]
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">{log.timestamp}</div>
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-slate-500">{log.expanded ? "Hide" : "Show"}</div>
                </button>

                {log.expanded && log.eventData && (
                  <div className="mt-2 text-left text-slate-900">
                    <pre className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                      {JSON.stringify(log.eventData, null, 2)}
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
