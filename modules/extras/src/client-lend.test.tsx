/* @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { ModuleClientHost, ModulePageProps } from "@matchdesk/module-sdk";
import createModule, { groupLendItems } from "./client";
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


const person = (id: string) => ({ id, username: id[0].toUpperCase() + id.slice(1), displayName: null });
type Lend = Parameters<typeof groupLendItems>[0][number];
function lendItem(id: string, title: string, owner: string, borrowedBy: string | null, extra: Partial<Lend> = {}): Lend {
  return {
    id,
    title,
    details: null,
    owner: person(owner),
    borrowedBy: borrowedBy ? person(borrowedBy) : null,
    borrowedAt: borrowedBy ? "2026-11-06T17:04:00.000Z" : null,
    returnedAt: null,
    out: Boolean(borrowedBy),
    canEdit: owner === "me",
    canReturn: Boolean(borrowedBy) && (owner === "me" || borrowedBy === "me"),
    ...extra
  };
}

/** 15 Einträge: 2 bei mir, 8 frei (unsortiert), 3 eigene Angebote, 2 an andere verliehen. */
function fifteen(): Lend[] {
  return [
    lendItem("b1", "Xbox-Controller", "tim", "me"),
    lendItem("f1", "Verlängerung 5 m", "jonas", null),
    lendItem("o1", "Headset HyperX", "me", null),
    lendItem("f2", "24\" Monitor (BenQ)", "sven", null, { details: "mit DisplayPort-Kabel" }),
    lendItem("x1", "Switch 8 Port", "lea", "kai"),
    lendItem("f3", "Maus Logitech", "lea", null),
    lendItem("o2", "Tastatur", "me", "nora"),
    lendItem("f4", "Beamer", "kai", null, { borrowedBy: person("ben"), returnedAt: "2026-11-07T10:00:00.000Z" }),
    lendItem("f5", "Kopfhörer", "nora", null),
    lendItem("b2", "Lüfter", "ben", "me"),
    lendItem("f6", "Adapter HDMI", "mia", null),
    lendItem("x2", "Router", "sven", "jonas"),
    lendItem("f7", "Zocker-Stuhl", "tim", null),
    lendItem("o3", "Netzwerkkabel 10 m", "me", null, { borrowedBy: person("tim"), returnedAt: "2026-11-07T09:00:00.000Z" }),
    lendItem("f8", "Gamepad", "jonas", null)
  ];
}

function lendOverview(lend: Lend[], ended = false) {
  return {
    event: { id: "lan", name: "LAN Herbst", status: ended ? "ended" : "running" },
    canManage: false,
    ended,
    me: { id: "me" },
    install: [],
    bring: [],
    lend,
    cost: null,
    rides: [],
    fields: []
  };
}

async function renderLendTab(lend: Lend[], ended = false, calls: string[] = []) {
  const host = buildHost({
    "/events": () => ({ events: [{ id: "lan", name: "LAN Herbst", status: ended ? "ended" : "running", canManage: false }] }),
    "/events/lan": () => lendOverview(lend, ended),
    ...Object.fromEntries(lend.flatMap((item) => [`/items/${item.id}/return`, `/items/${item.id}/borrow`]).map((path) => [path, () => (calls.push(path), lendOverview(lend, ended))]))
  });
  const { Page } = createModule(host);
  if (!Page) throw new Error("Page-Export fehlt");
  const element = await render(<Page {...pageProps()} />);
  await act(async () => {
    clickButton(element, CATALOG["tab.lend"]); // „Verleih"
    await flush();
  });
  return element;
}

const titles = (group: Element | null) => [...(group?.querySelectorAll(".device-list strong") ?? [])].map((node) => node.textContent);

describe("Event-Extras Verleih-Reiter (AP4)", () => {
  it("groupLendItems: eigene Leihen, frei (nach Name), eigene Angebote, an andere verliehen", () => {
    const groups = groupLendItems(fifteen(), "me", "de");
    expect(groups.borrowed.map((item) => item.id)).toEqual(["b2", "b1"]);
    expect(groups.free.map((item) => item.title)).toEqual([
      "24\" Monitor (BenQ)",
      "Adapter HDMI",
      "Beamer",
      "Gamepad",
      "Kopfhörer",
      "Maus Logitech",
      "Verlängerung 5 m",
      "Zocker-Stuhl"
    ]);
    // eigene Angebote bleiben in „Deine Angebote", auch wenn sie gerade verliehen sind
    expect(groups.offers.map((item) => item.id).sort()).toEqual(["o1", "o2", "o3"]);
    expect(groups.lentToOthers.map((item) => item.id).sort()).toEqual(["x1", "x2"]);
  });

  it("15 Einträge: Gruppen mit Zähler in dieser Reihenfolge, Frei-Gruppe vor den eigenen Angeboten", async () => {
    const element = await renderLendTab(fifteen());
    const groups = [...element.querySelectorAll(".lend-group")];
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["borrowed", "free", "offers", "lentToOthers"]);
    expect(groups[0].querySelector("h4")?.textContent).toBe("Du hast ausgeliehen (2)");
    expect(groups[1].querySelector("h4")?.textContent).toBe("Frei — kannst du ausleihen (8)");
    expect(groups[2].querySelector("h4")?.textContent).toBe("Deine Angebote (3)");
    // an andere verliehene Sachen stehen zugeklappt am Ende
    expect(groups[3].tagName).toBe("DETAILS");
    expect(groups[3].hasAttribute("open")).toBe(false);
    expect(groups[3].querySelector("summary")?.textContent).toBe("Gerade verliehen (2)");

    // Frei: jede Zeile mit grünem Badge „frei" und Knopf „Ausleihen", alphabetisch
    const free = groups[1];
    expect(titles(free)[0]).toBe("24\" Monitor (BenQ)");
    for (const row of free.querySelectorAll(".device-list > li")) {
      expect(row.querySelector(".badge--ok")?.textContent).toBe("frei");
      expect(row.querySelector(".device-actions button")?.textContent).toBe("Ausleihen");
    }
    expect(free.textContent).toContain("von Sven · mit DisplayPort-Kabel");

    // Du hast ausgeliehen: Badge „bei dir", Knopf „Zurückgegeben"
    const borrowed = groups[0];
    for (const row of borrowed.querySelectorAll(".device-list > li")) {
      expect(row.querySelector(".badge--warn")?.textContent).toBe("bei dir");
      expect(row.querySelector(".device-actions button")?.textContent).toBe("Zurückgegeben");
    }
    expect(borrowed.textContent).toContain("von Tim · seit");

    // Deine Angebote: frei / verliehen an … / zurückgegeben
    const rowOf = (title: string) => [...groups[2].querySelectorAll(".device-list > li")].find((li) => li.querySelector("strong")?.textContent === title)!;
    expect(rowOf("Headset HyperX").querySelector(".badge--ok")?.textContent).toBe("frei");
    expect(rowOf("Headset HyperX").textContent).toContain("niemand hat es ausgeliehen");
    expect(rowOf("Tastatur").querySelector(".badge--warn")?.textContent).toBe("verliehen an Nora");
    expect(rowOf("Netzwerkkabel 10 m").querySelector(".badge")?.className).toBe("badge");
    expect(rowOf("Netzwerkkabel 10 m").querySelector(".badge")?.textContent).toBe("zurückgegeben");

    // Formular „Gerät anbieten" steht am Ende und ist zugeklappt
    const offer = [...element.querySelectorAll("details.more-info")].find((node) => node.querySelector("summary")?.textContent === "Gerät anbieten");
    expect(offer).toBeTruthy();
    expect(offer?.hasAttribute("open")).toBe(false);
    expect(groups[3].compareDocumentPosition(offer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Zurückgeben bleibt nach Eventende bedienbar, Ausleihen und Anbieten nicht", async () => {
    const calls: string[] = [];
    const element = await renderLendTab(fifteen(), true, calls);
    const borrowed = element.querySelector('[data-group="borrowed"]') as HTMLElement;
    const row = [...borrowed.querySelectorAll(".device-list > li")].find((li) => li.querySelector("strong")?.textContent === "Xbox-Controller") as HTMLElement;
    await act(async () => {
      clickButton(row, "Zurückgegeben");
      await flush();
    });
    expect(calls).toEqual(["/items/b1/return"]);
    expect([...element.querySelectorAll("button")].some((button) => button.textContent === "Ausleihen")).toBe(false);
    expect([...element.querySelectorAll("summary")].some((node) => node.textContent === "Gerät anbieten")).toBe(false);
  });

  it("Leerzustände: leere Liste mit Hinweissatz, leere Gruppen entfallen, Frei zeigt eine Leerzeile", async () => {
    let element = await renderLendTab([]);
    expect(element.textContent).toContain("Noch bietet niemand etwas an. Trag ein, was du verleihen kannst.");
    expect(element.querySelector(".lend-group")).toBeNull();
    act(() => root!.unmount());
    container!.remove();
    root = undefined;

    element = await renderLendTab([lendItem("o1", "Headset", "me", null)]);
    expect([...element.querySelectorAll(".lend-group")].map((group) => group.getAttribute("data-group"))).toEqual(["free", "offers"]);
    expect(element.querySelector('[data-group="free"]')?.textContent).toContain("Gerade ist nichts frei.");
  });
});
