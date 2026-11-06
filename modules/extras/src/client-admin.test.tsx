/* @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { ModuleClientHost } from "@matchdesk/module-sdk";
import createModule from "./client";

const TEXT: Record<string, string> = {
  "admin.intro": "Kurzüberblick je laufendem Event. Verwalten lässt sich alles auf der Modulseite.",
  "admin.loading": "…",
  "admin.noRunning": "Aktuell läuft kein Event.",
  "admin.summary": "{bring} Mitbringen · {install} Installation(en) · {lend} Verleih · {rides} Fahrt(en) · {fields} Frage(n)",
  "admin.costSet": "Beitrag gesetzt",
  "admin.costNotSet": "Kein Beitrag",
  "admin.openModule": "Zur Modulseite"
};

function buildHost(routes: Record<string, () => unknown>): ModuleClientHost {
  return {
    id: "extras",
    version: "1.1.0",
    matchdeskApi: 1,
    React,
    locale: "de",
    t: (key, vars) => {
      let value = TEXT[key] ?? key;
      for (const [name, replacement] of Object.entries(vars ?? {})) value = value.replace(`{${name}}`, String(replacement));
      return value;
    },
    api: async <T = unknown,>(path: string): Promise<T> => {
      const handler = routes[path];
      if (!handler) throw new Error(`keine Route für ${path}`);
      return handler() as T;
    },
    onRealtime: () => () => undefined
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root && container) {
    act(() => root!.unmount());
    container.remove();
  }
  root = undefined;
  container = undefined;
});

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await flush();
  });
  return container;
}

const adminUser = { id: "admin", username: "admin", role: "admin" as const };

describe("Event-Extras Admin-Seite", () => {
  it("zeigt nur laufende Events mit Kurzüberblick und Link zur Modulseite", async () => {
    const host = buildHost({
      "/events": () => ({
        events: [
          { id: "lan", name: "LAN Herbst", status: "running", canManage: true },
          { id: "next", name: "Nächstes LAN", status: "open", canManage: true }
        ]
      }),
      "/events/lan": () => ({
        event: { id: "lan", name: "LAN Herbst", status: "running" },
        canManage: true,
        ended: false,
        me: { id: "admin" },
        install: [{ id: "1" }],
        bring: [{ id: "2" }, { id: "3" }],
        lend: [],
        cost: { amountCents: 500, currency: "EUR", note: null, paypalUrl: null, dueDate: null, mine: null },
        rides: [],
        fields: [{ id: "4" }]
      })
    });
    const { Admin } = createModule(host);
    if (!Admin) throw new Error("Admin-Export fehlt");
    const element = await render(<Admin user={adminUser} settings={{}} reloadSettings={() => undefined} />);

    expect(element.textContent).toContain("LAN Herbst");
    expect(element.textContent).not.toContain("Nächstes LAN");
    expect(element.textContent).toContain("2 Mitbringen");
    expect(element.textContent).toContain("Beitrag gesetzt");
    const link = element.querySelector("a");
    expect(link?.getAttribute("href")).toBe("#mitmachen/extras");
  });

  it("zeigt einen Hinweis, wenn kein Event läuft", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "x", name: "X", status: "open", canManage: false }] })
    });
    const { Admin } = createModule(host);
    if (!Admin) throw new Error("Admin-Export fehlt");
    const element = await render(<Admin user={adminUser} settings={{}} reloadSettings={() => undefined} />);

    expect(element.textContent).toContain("Aktuell läuft kein Event.");
  });
});
