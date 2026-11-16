/* @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { ModuleClientHost, ModulePageProps } from "@matchdesk/module-sdk";
import createModule from "./client";
import deCatalog from "../i18n/de.json";

const CATALOG = deCatalog as Record<string, string>;

function buildHost(routes: Record<string, (init?: RequestInit) => unknown>): ModuleClientHost {
  return {
    id: "extras",
    version: "1.1.0",
    matchdeskApi: 1,
    React,
    locale: "de",
    t: (key, vars) => {
      let value = CATALOG[key] ?? key;
      for (const [name, replacement] of Object.entries(vars ?? {})) value = value.split(`{${name}}`).join(String(replacement));
      return value;
    },
    api: async <T = unknown,>(path: string, init?: RequestInit): Promise<T> => {
      const handler = routes[path];
      if (!handler) throw new Error(`keine Route für ${path}`);
      return handler(init) as T;
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

/** Intl setzt zwischen Zahl und Währung ein schmales geschütztes Leerzeichen; für Vergleiche vereinheitlichen. */
const norm = (value: string | null | undefined) => (value ?? "").replace(/[  ]/g, " ");

function clickButton(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Knopf „${label}" nicht gefunden`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const user = { id: "me", username: "paula", role: "user" as const };
const pageProps = (subPath = "extras"): ModulePageProps => ({ path: "mitmachen/extras", subPath, user, permissions: ["extras.view", "extras.manage"] });

/** 25 Teilnehmer: 18 bestätigt, 2 gemeldet (Lea PayPal, Tim bar), 5 nichts gemeldet. */
function buildPayments() {
  const confirmed = Array.from({ length: 18 }, (_, index) => ({
    user: { id: `c${index}`, username: `Confy${index}`, displayName: null },
    payment: { method: index % 2 ? "cash" : "paypal", status: "confirmed", reportedAt: "2026-11-05T10:00:00.000Z", confirmedAt: "2026-11-06T09:30:00.000Z" }
  }));
  const reported = [
    { user: { id: "lea", username: "Lea", displayName: null }, payment: { method: "paypal", status: "reported", reportedAt: "2026-11-06T17:42:00.000Z", confirmedAt: null } },
    { user: { id: "tim", username: "Tim", displayName: null }, payment: { method: "cash", status: "reported", reportedAt: "2026-11-06T18:05:00.000Z", confirmedAt: null } }
  ];
  const nothing = ["Nora", "Kai", "Jonas", "Mia", "Ben"].map((named) => ({ user: { id: named.toLowerCase(), username: named, displayName: null }, payment: null }));
  return [...confirmed, ...reported, ...nothing];
}

function overview(options: { canManage: boolean; mine?: unknown; withPayments?: boolean }) {
  return {
    event: { id: "lan", name: "LAN Herbst", status: "running" },
    canManage: options.canManage,
    ended: false,
    me: { id: "me" },
    install: [],
    bring: [],
    lend: [],
    cost: {
      amountCents: 1500,
      currency: "EUR",
      note: "Strom, Getränke, Snacks.",
      paypalUrl: "https://paypal.me/sven",
      dueDate: "2026-11-10",
      mine: options.mine ?? null,
      payments: options.withPayments ? buildPayments() : undefined
    },
    rides: [],
    fields: []
  };
}

async function renderCostTab(host: ModuleClientHost, subPath = "extras") {
  const { Page } = createModule(host);
  if (!Page) throw new Error("Page-Export fehlt");
  const element = await render(<Page {...pageProps(subPath)} />);
  await act(async () => {
    clickButton(element, CATALOG["tab.cost"]); // „Beitrag"
    await flush();
  });
  return element;
}

describe("Event-Extras Beitrag-Reiter (AP3)", () => {
  it("Teilnehmer: Betrag, Badge offen, Frist im Klartext und PayPal-Knopf als .button-link", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: "running", canManage: false }] }),
      "/events/lan": () => overview({ canManage: false })
    });
    const element = await renderCostTab(host);

    expect(norm(element.textContent)).toContain("15,00 € pro Person");
    expect(element.textContent).toContain("Zahlen bis");
    expect(element.textContent).toContain("Noch nichts gemeldet");
    // Kriterium 3: sichtbarer .button-link, der den PayPal-Link öffnet
    const pay = [...element.querySelectorAll("a.button-link")].find((anchor) => anchor.textContent?.trim() === "Mit PayPal zahlen");
    expect(pay).toBeTruthy();
    expect(pay?.getAttribute("href")).toBe("https://paypal.me/sven");
    // kein alter, nicht existierender .button
    expect(element.querySelector("a.button:not(.button-link)")).toBeNull();
    // alle drei Melde-Knöpfe da
    const labels = [...element.querySelectorAll("button, a.button-link")].map((node) => node.textContent?.trim());
    expect(labels).toContain("Mit PayPal zahlen");
    expect(labels).toContain("Per PayPal bezahlt");
    expect(labels).toContain("Bar bezahlt");
    // Teilnehmer sieht keine Orga-Kennzahlen
    expect(element.querySelector(".status-grid")).toBeNull();
  });

  it("Teilnehmer: bestätigter Beitrag zeigt grünes Badge und keine Knöpfe", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: "running", canManage: false }] }),
      "/events/lan": () => overview({ canManage: false, mine: { method: "cash", status: "confirmed", reportedAt: "2026-11-05T10:00:00.000Z", confirmedAt: "2026-11-06T09:30:00.000Z" } })
    });
    const element = await renderCostTab(host);

    expect(element.querySelector(".badge--ok")?.textContent).toContain("bestätigt");
    expect(element.textContent).toContain("Deine Zahlung ist bestätigt.");
    expect([...element.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Bar bezahlt")).toBe(false);
  });

  it("Orga: Kennzahlen als .status-grid und Filter mit Vorauswahl Offen (7 = gemeldet + nichts)", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: "running", canManage: true }] }),
      "/events/lan": () => overview({ canManage: true, withPayments: true })
    });
    const element = await renderCostTab(host);

    const grid = element.querySelector(".status-grid");
    expect(grid).toBeTruthy();
    expect(norm(grid?.textContent)).toContain("18 von 25");
    expect(norm(grid?.textContent)).toContain("270,00 € von 375,00 €");

    const filter = element.querySelector(".tab-strip--filter");
    expect(filter).toBeTruthy();
    expect(filter?.textContent).toContain("Offen (7)");
    expect(filter?.textContent).toContain("Gemeldet (2)");
    expect(filter?.textContent).toContain("Bestätigt (18)");
    expect(filter?.textContent).toContain("Alle (25)");
    // aktiver Filter ist „Offen"
    const active = filter?.querySelector(".tab-strip__tab.active");
    expect(active?.textContent).toContain("Offen (7)");

    // Vorauswahl Offen zeigt gemeldete und nichts-gemeldete, nicht die bestätigten
    const list = element.querySelector(".device-list");
    expect(list?.textContent).toContain("Lea");
    expect(list?.textContent).toContain("Nora");
    expect(list?.textContent).not.toContain("Confy0");
    // 7 Zeilen, je genau eine Aktion
    const rows = [...(list?.querySelectorAll(":scope > li") ?? [])];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.querySelectorAll(".device-actions button")).toHaveLength(1);
  });

  it("Orga: je Zustand genau eine sinnvolle Aktion; Zustände eindeutig unterscheidbar", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: "running", canManage: true }] }),
      "/events/lan": () => overview({ canManage: true, withPayments: true })
    });
    const element = await renderCostTab(host);
    const rowByName = (named: string) =>
      [...element.querySelectorAll(".device-list > li")].find((li) => li.querySelector("strong")?.textContent === named);

    // gemeldet → „Bestätigen", amber Badge mit Zahlart
    const lea = rowByName("Lea")!;
    expect(lea.querySelector(".badge--warn")?.textContent).toBe("gemeldet · PayPal");
    expect(lea.textContent).toContain("gemeldet am");
    expect(lea.querySelector(".device-actions button")?.textContent).toBe("Bestätigen");

    // offen → „Bar erhalten", neutrales Badge
    const nora = rowByName("Nora")!;
    expect(nora.querySelector(".badge")?.className).toBe("badge");
    expect(nora.querySelector(".badge")?.textContent).toBe("offen");
    expect(nora.textContent).toContain("nichts gemeldet");
    expect(nora.querySelector(".device-actions button")?.textContent).toBe("Bar erhalten");

    // Umschalten auf „Bestätigt" → confirmed-Zeilen mit „Auf offen setzen"
    await act(async () => {
      clickButton(element.querySelector(".tab-strip--filter") as HTMLElement, "Bestätigt (18)");
      await flush();
    });
    const confy = rowByName("Confy0")!;
    expect(confy.querySelector(".badge--ok")?.textContent).toContain("bestätigt");
    expect(confy.querySelector(".device-actions button")?.textContent).toBe("Auf offen setzen");
    expect(element.querySelector(".device-list")?.textContent).not.toContain("Lea");
  });

  it("Orga ist selbst Teilnehmer: sieht eigenen Beitrag (PayPal-Knopf, Badge) UND die Kennzahlen", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: "running", canManage: true }] }),
      "/events/lan": () => overview({ canManage: true, mine: { method: "paypal", status: "reported", reportedAt: "2026-11-06T17:42:00.000Z", confirmedAt: null }, withPayments: true })
    });
    const element = await renderCostTab(host);

    // Teilnehmer-Sicht bleibt sichtbar: eigener PayPal-Knopf als .button-link mit dem hinterlegten Link
    const pay = [...element.querySelectorAll("a.button-link")].find((anchor) => anchor.textContent?.trim() === "Mit PayPal zahlen");
    expect(pay).toBeTruthy();
    expect(pay?.getAttribute("href")).toBe("https://paypal.me/sven");
    // eigener Zustand als Badge (gemeldet) im Kopfbereich
    expect([...element.querySelectorAll(".badge--warn")].some((badge) => badge.textContent?.trim() === "gemeldet")).toBe(true);
    // Orga-Kennzahlen kommen zusätzlich darunter
    expect(element.querySelector(".status-grid")).toBeTruthy();
    expect(element.querySelector(".tab-strip--filter")?.textContent).toContain("Offen (7)");
  });

  it("Orga: Filter wird aus dem Pfad gelesen (.../beitrag/alle -> Vorauswahl Alle)", async () => {
    const host = buildHost({
      "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: "running", canManage: true }] }),
      "/events/lan": () => overview({ canManage: true, withPayments: true })
    });
    const element = await renderCostTab(host, "extras/beitrag/alle");

    const active = element.querySelector(".tab-strip--filter .tab-strip__tab.active");
    expect(active?.textContent).toContain("Alle (25)");
    // „Alle" zeigt alle 25 Zeilen (bestätigte eingeschlossen)
    expect(element.querySelectorAll(".device-list > li")).toHaveLength(25);
    expect(element.querySelector(".device-list")?.textContent).toContain("Confy0");
  });
});
