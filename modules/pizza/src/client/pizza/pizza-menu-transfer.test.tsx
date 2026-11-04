/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { requestJson } from "../api/request";
import { ApiError } from "../errors/errors";
import { I18nProvider } from "../test-support";
import { publishEventsChanged } from "../test-support";
import { LIVE_REFRESH_DEBOUNCE_MS } from "../realtime/use-events-changed";
import type { PizzaMenuTransferResult } from "./api";
import { decodeImportFile, guessFormat, PizzaMenuTransfer } from "./PizzaMenuTransfer";

vi.mock("../api/request", () => ({ requestJson: vi.fn() }));
const requestJsonMock = vi.mocked(requestJson);

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let mounted: { root: Root; container: HTMLElement } | null = null;

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function mockApi(routes: Record<string, (call: Call) => unknown>) {
  requestJsonMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = (options?.method ?? "GET").toUpperCase();
    const call = { url, method, body: options?.body ? JSON.parse(String(options.body)) : undefined };
    calls.push(call);
    return routes[`${method} ${url}`]?.(call);
  });
}

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider locale="de">{element}</I18nProvider>);
    await flush();
  });
  mounted = { root, container };
  return container;
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("Element nicht gefunden");
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

async function typeText(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

const counts = (partial: Partial<Record<"new" | "changed" | "unchanged" | "removed", number>> = {}) => ({
  new: 0,
  changed: 0,
  unchanged: 0,
  removed: 0,
  ...partial
});

function result(overrides: Partial<PizzaMenuTransferResult> = {}): PizzaMenuTransferResult {
  return {
    format: "csv",
    sections: { menu: true, extras: false },
    counts: {
      categories: counts({ unchanged: 2 }),
      items: counts({ new: 1, unchanged: 89, changed: 1 }),
      variants: counts({ changed: 3, unchanged: 190 }),
      extras: counts()
    },
    errors: [],
    warnings: [],
    menuVersion: "v1",
    ...overrides
  };
}

const CSV = "kategorie;nummer;artikel;zutaten;allergene;variante;preis_eur;aktiv\nPizza;01;Margherita;;;30cm;7,50;ja";

beforeEach(() => {
  calls = [];
  requestJsonMock.mockReset();
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => {
      root.unmount();
      await flush();
    });
    container.remove();
    mounted = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PizzaMenuTransfer", () => {
  it("zeigt erst eine Vorschau und übernimmt danach", async () => {
    mockApi({
      "POST /api/m/pizza/admin/menu/transfer/preview": () => result(),
      "POST /api/m/pizza/admin/menu/transfer/apply": () => result()
    });
    const onChanged = vi.fn();
    const container = await render(<PizzaMenuTransfer onChanged={onChanged} />);

    expect(container.querySelector('a[href="/api/m/pizza/admin/menu/export.yaml"]')).not.toBeNull();
    expect(container.querySelector('a[href="/api/m/pizza/admin/menu/export.csv"]')).not.toBeNull();
    expect(container.querySelector('a[href="/api/m/pizza/admin/menu/extras-export.csv"]')).not.toBeNull();
    expect(button(container, "Übernehmen")!.disabled).toBe(true);

    await choose(container.querySelector("select")!, "csv");
    await typeText(container.querySelector("textarea")!, CSV);
    await click(button(container, "Vorschau"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/menu/transfer/preview",
      method: "POST",
      body: { format: "csv", content: CSV }
    });
    const items = container.querySelector('[data-testid="pizza-transfer-count-items"]')!;
    expect(Array.from(items.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual(["1", "1", "89", "0"]);
    expect(container.querySelector('[data-testid="pizza-transfer-count-extras"]')).toBeNull();

    await click(button(container, "Übernehmen"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/menu/transfer/apply",
      method: "POST",
      body: { format: "csv", content: CSV, expectedVersion: "v1" }
    });
    expect(container.textContent).toContain("Übernommen – Kategorien: 0 neu, 0 geändert, 0 entfernt");
    expect(onChanged).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="pizza-transfer-preview"]')).toBeNull();
  });

  it("zeigt Fehler mit Zeilennummer und sperrt Übernehmen", async () => {
    mockApi({
      "POST /api/m/pizza/admin/menu/transfer/preview": () =>
        result({ errors: [{ line: 3, code: "invalid_price", params: { value: "sieben" } }, { line: null, code: "neu" }] })
    });
    const container = await render(<PizzaMenuTransfer />);
    await typeText(container.querySelector("textarea")!, CSV);
    await click(button(container, "Vorschau"));
    expect(container.textContent).toContain("2 Fehler – nichts wird übernommen");
    expect(container.textContent).toContain("Zeile 3: Ungültiger Preis „sieben“");
    expect(container.textContent).toContain("Unbekannter Fehler (neu).");
    expect(button(container, "Übernehmen")!.disabled).toBe(true);
  });

  it("verlangt nach Änderungen am Inhalt eine neue Vorschau und zeigt Fehler beim Übernehmen", async () => {
    mockApi({
      "POST /api/m/pizza/admin/menu/transfer/preview": () => result(),
      "POST /api/m/pizza/admin/menu/transfer/apply": () => {
        throw new ApiError({
          code: "pizza_import_fehlerhaft",
          status: 400,
          body: { error: "pizza_import_fehlerhaft", result: result({ errors: [{ line: 2, code: "unknown_category", params: { name: "Desserts" } }] }) }
        });
      }
    });
    const container = await render(<PizzaMenuTransfer />);
    const textarea = container.querySelector("textarea")!;
    await typeText(textarea, CSV);
    await click(button(container, "Vorschau"));
    await typeText(textarea, `${CSV}\n`);
    expect(button(container, "Übernehmen")!.disabled).toBe(true);
    expect(container.textContent).toContain("bitte erneut prüfen");
    await typeText(textarea, CSV);
    await click(button(container, "Übernehmen"));
    expect(container.textContent).toContain("Zeile 2: Unbekannte Kategorie „Desserts“.");
  });

  it("behält Inhalt und Vorschau bei Live-Änderungen und markiert sie als veraltet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockApi({ "POST /api/m/pizza/admin/menu/transfer/preview": () => result() });
    const container = await render(<PizzaMenuTransfer />);
    const textarea = container.querySelector("textarea")!;
    await typeText(textarea, CSV);
    await click(button(container, "Vorschau"));

    await act(async () => {
      publishEventsChanged("pizza_menu_changed");
      vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS);
      await flush();
    });

    expect(container.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe(CSV);
    expect(container.querySelector('[data-testid="pizza-transfer-preview"]')).not.toBeNull();
    expect(container.textContent).toContain("Das Menü wurde inzwischen geändert");
    expect(calls.filter((call) => call.url.endsWith("/apply"))).toHaveLength(0);
    // Veraltete Vorschau: erst neu prüfen, dann übernehmen
    expect(button(container, "Übernehmen")!.disabled).toBe(true);
    await click(button(container, "Vorschau"));
    expect(container.textContent).not.toContain("Das Menü wurde inzwischen geändert");
    expect(button(container, "Übernehmen")!.disabled).toBe(false);
  });

  it("verlangt bei vielen Entfernungen eine Bestätigung", async () => {
    mockApi({
      "POST /api/m/pizza/admin/menu/transfer/preview": () =>
        result({
          counts: { ...result().counts, items: counts({ unchanged: 1, removed: 89 }) },
          warnings: [{ line: null, code: "many_removed", params: { kind: "items", count: 89, total: 90 } }]
        }),
      "POST /api/m/pizza/admin/menu/transfer/apply": () => result()
    });
    const container = await render(<PizzaMenuTransfer />);
    await typeText(container.querySelector("textarea")!, CSV);
    await click(button(container, "Vorschau"));
    expect(container.textContent).toContain("Achtung: 89 von 90 Artikel würden entfernt bzw. deaktiviert");
    expect(button(container, "Übernehmen")!.disabled).toBe(true);

    const confirm = Array.from(container.querySelectorAll<HTMLInputElement>(".pizza-transfer__warnings input"))[0];
    await click(confirm);
    expect(button(container, "Übernehmen")!.disabled).toBe(false);
    await click(button(container, "Übernehmen"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/menu/transfer/apply",
      method: "POST",
      body: { format: "yaml", content: CSV, expectedVersion: "v1", confirmRemovals: true }
    });
  });

  it("zeigt bei 409 (Menü inzwischen geändert) die neue Vorschau statt zu übernehmen", async () => {
    mockApi({
      "POST /api/m/pizza/admin/menu/transfer/preview": () => result(),
      "POST /api/m/pizza/admin/menu/transfer/apply": () => {
        throw new ApiError({
          code: "pizza_menu_geaendert",
          status: 409,
          body: {
            error: "pizza_menu_geaendert",
            result: result({ menuVersion: "v2", counts: { ...result().counts, items: counts({ changed: 7, unchanged: 83 }) } })
          }
        });
      }
    });
    const container = await render(<PizzaMenuTransfer />);
    await typeText(container.querySelector("textarea")!, CSV);
    await click(button(container, "Vorschau"));
    await click(button(container, "Übernehmen"));
    expect(container.textContent).toContain("Das Menü wurde inzwischen geändert. Nichts übernommen");
    const items = container.querySelector('[data-testid="pizza-transfer-count-items"]')!;
    expect(Array.from(items.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual(["0", "7", "83", "0"]);
  });
});

describe("Dateien lesen", () => {
  it("erkennt UTF-8 mit BOM und fällt für Excel-CSV auf Windows-1252 zurück", () => {
    const utf8 = new TextEncoder().encode("﻿kategorie;artikel\nPasta;Käse");
    expect(decodeImportFile(utf8.buffer as ArrayBuffer)).toContain("Käse");
    const cp1252 = new Uint8Array([0x4b, 0xe4, 0x73, 0x65]); // "Käse" in Windows-1252
    expect(decodeImportFile(cp1252.buffer)).toBe("Käse");
  });

  it("errät das Format", () => {
    expect(guessFormat("menu.yaml", "")).toBe("yaml");
    expect(guessFormat("menu.yml", "")).toBe("yaml");
    expect(guessFormat("menu.csv", "﻿kategorie;nummer")).toBe("csv");
    expect(guessFormat("extras.csv", "extra;preis_eur;kategorien;aktiv")).toBe("extras_csv");
    expect(guessFormat("x.txt", "kategorien:\n")).toBe("yaml");
  });
});
