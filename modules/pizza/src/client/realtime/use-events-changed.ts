import { useEffect, useRef } from "react";
import { host } from "../host";

export const LIVE_REFRESH_DEBOUNCE_MS = 300;

/**
 * Ruft `onChange` entprellt auf, wenn das Modul `changed` meldet (Server: ctx.realtime.broadcast).
 * Mehrere Signale innerhalb von `debounceMs` ergeben genau einen Aufruf.
 */
export function useEventsChanged(
  onChange: () => void,
  accept: (reason: string | null) => boolean,
  debounceMs = LIVE_REFRESH_DEBOUNCE_MS
) {
  const onChangeRef = useRef(onChange);
  const acceptRef = useRef(accept);
  onChangeRef.current = onChange;
  acceptRef.current = accept;

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = host().onRealtime("changed", (data) => {
      const reason = typeof (data as { reason?: unknown } | null)?.reason === "string" ? (data as { reason: string }).reason : null;
      if (!acceptRef.current(reason)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        onChangeRef.current();
      }, debounceMs);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [debounceMs]);
}
