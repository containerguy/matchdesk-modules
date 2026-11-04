import React from "react";
import type { ModuleClientHost } from "@matchdesk/module-sdk";
import de from "../../i18n/de.json";
import en from "../../i18n/en.json";
import { setHost } from "./host";

/*
 * Nur für Tests: ein Host wie im Kern (Texte aus i18n/*.json, Realtime als lokaler Verteiler).
 * Ersetzt in den übernommenen Tests den I18nProvider und publishEventsChanged des Kerns.
 */

type Handler = (data: unknown) => void;
const realtime = new Map<string, Set<Handler>>();

function testHost(locale: "de" | "en"): ModuleClientHost {
  const catalog: Record<string, string> = locale === "en" ? { ...de, ...en } : de;
  return {
    id: "pizza",
    version: "0.0.0-test",
    matchdeskApi: 1,
    React,
    locale,
    t: (key, vars) => {
      let text = catalog[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
      return text;
    },
    api: () => Promise.reject(new Error("api im Test nicht gemockt")),
    onRealtime: (event, handler) => {
      const set = realtime.get(event) ?? new Set<Handler>();
      set.add(handler);
      realtime.set(event, set);
      return () => set.delete(handler);
    }
  };
}

setHost(testHost("de"));

export function I18nProvider({ locale, children }: { locale: "de" | "en"; children: React.ReactNode }) {
  setHost(testHost(locale));
  return <>{children}</>;
}

/** Wie `ctx.realtime.broadcast("changed", { reason })` auf dem Server. */
export function publishEventsChanged(reason: string | null) {
  for (const handler of Array.from(realtime.get("changed") ?? [])) handler({ reason });
}
