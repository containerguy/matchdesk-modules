/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { requestJson } from "../api/request";
import { I18nProvider } from "../test-support";
import { publishEventsChanged } from "../test-support";
import { LIVE_REFRESH_DEBOUNCE_MS } from "../realtime/use-events-changed";
import { PizzaPanel } from "./PizzaPanel";
import type { PizzaItem, PizzaOrderWithUser, PizzaPanelState } from "./types";

vi.mock("../api/request", () => ({ requestJson: vi.fn() }));

const requestJsonMock = vi.mocked(requestJson);

type Handler = (body: unknown) => unknown;
let routes: Record<string, Handler> = {};
let calls: Array<{ url: string; method: string }> = [];

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function installApi() {
  requestJsonMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = (options?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const handler = routes[`${method} ${url}`];
    if (!handler) return undefined;
    return handler(options?.body ? JSON.parse(String(options.body)) : undefined);
  });
}

function count(method: string, url: string) {
  return calls.filter((call) => call.method === method && call.url === url).length;
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider locale="de">{element}</I18nProvider>);
    await flushMicrotasks();
  });
  mounted = { root, container };
  return container;
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("Element nicht gefunden");
  await act(async () => {
    (element as HTMLElement).click();
    await flushMicrotasks();
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushMicrotasks();
  });
}

/** Simuliert ein `events_changed` über den Bus und lässt die Entprellung ablaufen. */
async function liveSignal(...reasons: Array<string | null>) {
  await act(async () => {
    for (const reason of reasons) publishEventsChanged(reason);
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS);
    await flushMicrotasks();
  });
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text
  );
}

function byAriaLabel<T extends Element>(container: HTMLElement, label: string) {
  return container.querySelector<T>(`[aria-label="${label}"]`);
}

function item(id: string, number: string, name: string): PizzaItem {
  return {
    id,
    number,
    name,
    ingredients: null,
    allergens: null,
    categoryId: "cat-pizza",
    active: true,
    sortOrder: Number(number),
    variants: [
      { id: `${id}-30`, itemId: id, sizeLabel: "30cm", priceCents: 700, sortOrder: 1, active: true }
    ]
  };
}

const margherita = item("pi-001", "1", "Margherita");
const funghi = item("pi-002", "2", "Funghi");

function myOrder(): PizzaOrderWithUser {
  return {
    id: "o1",
    sessionId: "s1",
    userId: "u1",
    paymentStatus: "unpaid",
    paymentMethod: null,
    paidAt: null,
    paidByAdminId: null,
    user: { username: "gast", displayName: "Gast" },
    lines: [
      {
        id: "l1",
        orderId: "o1",
        variantId: "pi-001-30",
        qty: 1,
        priceCentsSnapshot: 700,
        customNote: null,
        createdAt: "2026-10-01T18:00:00.000Z",
        itemNumber: "1",
        itemName: "Margherita",
        sizeLabel: "30cm"
      }
    ]
  };
}

function openState(menu: PizzaItem[]): PizzaPanelState {
  const own = myOrder();
  return {
    session: {
      id: "s1",
      state: "open",
      label: null,
      openedAt: "2026-10-01T18:00:00.000Z",
      lockedAt: null,
      deliveredAt: null
    },
    menu,
    paymentMethods: ["cash"],
    myOrder: own,
    orders: [own],
    guestTotals: [{ userId: "u1", totalCents: 700 }]
  };
}

const props = {
  currentUserId: "u1",
  paypalHandle: "",
  paypalName: "",
  cashRecipient: ""
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  routes = {};
  calls = [];
  requestJsonMock.mockReset();
  installApi();
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    container.remove();
    mounted = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PizzaPanel – Live-Aktualisierung", () => {
  it("lädt bei pizza_* entprellt genau einmal neu und zeigt neue Daten", async () => {
    let state = openState([margherita]);
    routes["GET /api/m/pizza/state"] = () => state;
    const container = await render(<PizzaPanel {...props} currentUserRole="user" />);
    expect(count("GET", "/api/m/pizza/state")).toBe(1);

    state = { ...state, orders: [...state.orders, { ...myOrder(), id: "o2", userId: "u2", user: { username: "zweiter", displayName: "Zweiter Gast" } }] };
    await liveSignal("pizza_line_added", "pizza_line_updated", "pizza_line_added");

    expect(count("GET", "/api/m/pizza/state")).toBe(2);
    expect(container.textContent).toContain("Zweiter Gast");
  });

  it("ignoriert Gründe ohne pizza_-Präfix", async () => {
    routes["GET /api/m/pizza/state"] = () => openState([margherita]);
    await render(<PizzaPanel {...props} currentUserRole="user" />);

    await liveSignal("event_created", "participation_updated");
    expect(count("GET", "/api/m/pizza/state")).toBe(1);
  });

  it("behält angefangene Eingaben im Bestellformular und zeigt den neuen Artikel", async () => {
    let state = openState([margherita]);
    routes["GET /api/m/pizza/state"] = () => state;
    const container = await render(<PizzaPanel {...props} currentUserRole="user" />);

    await click(buttonByText(container, "Menü öffnen (2 frei)"));
    const note = byAriaLabel<HTMLInputElement>(container, "Sonderwunsch (optional)")!;
    await type(note, "ohne Zwiebeln");
    expect(container.textContent).not.toContain("Funghi");

    state = openState([margherita, funghi]);
    await liveSignal("pizza_menu_changed");

    expect(count("GET", "/api/m/pizza/state")).toBe(2);
    expect(container.querySelector(".pizza-loading")).toBeNull();
    // gleicher DOM-Knoten, nicht neu gemountet, Eingabe unverändert und nicht gespeichert
    expect(byAriaLabel<HTMLInputElement>(container, "Sonderwunsch (optional)")).toBe(note);
    expect(note.value).toBe("ohne Zwiebeln");
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
    // Menü bleibt offen und enthält den neuen Artikel
    expect(container.querySelector(".pizza-menu-browser")?.textContent).toContain("Funghi");
  });

  it("behält offene Formulare im Menü-Editor und zeigt den neuen Artikel", async () => {
    let adminMenu = [margherita];
    routes["GET /api/m/pizza/state"] = () => ({
      ...openState(adminMenu),
      session: null,
      myOrder: null,
      orders: [],
      guestTotals: []
    });
    routes["GET /api/m/pizza/admin/menu"] = () => ({ items: adminMenu });
    const container = await render(<PizzaPanel {...props} currentUserRole="manager" />);

    await click(buttonByText(container, "Menü verwalten"));
    await click(byAriaLabel(container, "Bearbeiten: Margherita"));
    const price = byAriaLabel<HTMLInputElement>(container, "Preis in €: Margherita 30cm")!;
    await type(price, "9,50");
    await click(buttonByText(container, "Neuer Artikel"));
    const form = container.querySelector<HTMLFormElement>(".pizza-menu-editor__form")!;
    const nameInput = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Name"))!
      .querySelector("input")!;
    await type(nameInput, "Hausspezial");

    adminMenu = [margherita, funghi];
    await liveSignal("pizza_menu_changed");

    expect(count("GET", "/api/m/pizza/admin/menu")).toBe(2);
    expect(container.textContent).toContain("2 von 2 Artikeln");
    expect(container.querySelector('[data-testid="pizza-menu-item-pi-002"]')?.textContent).toContain("Funghi");
    expect(nameInput.isConnected).toBe(true);
    expect(nameInput.value).toBe("Hausspezial");
    expect(byAriaLabel<HTMLInputElement>(container, "Preis in €: Margherita 30cm")).toBe(price);
    expect(price.value).toBe("9,50");
  });

  it("behält die Extras-Auswahl im Bestellformular und schickt sie danach mit", async () => {
    const ham = { id: "x-ham", name: "extra Schinken", priceCents: 150, active: true, sortOrder: 1, categoryIds: ["cat-pizza"] };
    let state: PizzaPanelState = { ...openState([margherita]), extras: [ham] };
    routes["GET /api/m/pizza/state"] = () => state;
    routes["POST /api/m/pizza/lines"] = () => ({ lineId: "l2", orderId: "o1" });
    const container = await render(<PizzaPanel {...props} currentUserRole="user" />);

    await click(buttonByText(container, "Menü öffnen (2 frei)"));
    const checkbox = byAriaLabel<HTMLInputElement>(container, "extra Schinken für Margherita")!;
    await click(checkbox);
    expect(checkbox.checked).toBe(true);

    state = { ...openState([margherita, funghi]), extras: [ham] };
    await liveSignal("pizza_menu_changed", "pizza_line_added");

    expect(count("GET", "/api/m/pizza/state")).toBe(2);
    expect(byAriaLabel<HTMLInputElement>(container, "extra Schinken für Margherita")).toBe(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(byAriaLabel<HTMLInputElement>(container, "extra Schinken für Funghi")!.checked).toBe(false);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);

    const entry = container.querySelector<HTMLElement>('[data-testid="pizza-menu-entry-pi-001"]')!;
    await click(Array.from(entry.querySelectorAll("button")).find((button) => button.textContent?.includes("30cm")));
    const post = requestJsonMock.mock.calls.find(([url, options]) => url === "/api/m/pizza/lines" && options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ variantId: "pi-001-30", extraIds: ["x-ham"] });
  });

  it("behält die Extras-Auswahl, wenn der Artikel währenddessen die Kategorie wechselt", async () => {
    const ham = { id: "x-ham", name: "extra Schinken", priceCents: 150, active: true, sortOrder: 1, categoryIds: ["cat-pizza", "cat-spezial"] };
    const categories = [
      { id: "cat-pizza", name: "Pizza", sortOrder: 1 },
      { id: "cat-spezial", name: "Spezial", sortOrder: 2 }
    ];
    let state: PizzaPanelState = { ...openState([margherita, funghi]), categories, extras: [ham] };
    routes["GET /api/m/pizza/state"] = () => state;
    routes["POST /api/m/pizza/lines"] = () => ({ lineId: "l2", orderId: "o1" });
    const container = await render(<PizzaPanel {...props} currentUserRole="user" />);

    await click(buttonByText(container, "Menü öffnen (2 frei)"));
    await click(byAriaLabel(container, "extra Schinken für Funghi"));

    // Ein Manager verschiebt Funghi nach „Spezial“: der Eintrag wird in der neuen Gruppe neu gemountet
    state = { ...state, menu: [margherita, { ...funghi, categoryId: "cat-spezial" }] };
    await liveSignal("pizza_menu_changed");

    const checkbox = byAriaLabel<HTMLInputElement>(container, "extra Schinken für Funghi")!;
    expect(checkbox.closest("details")?.querySelector("summary")?.textContent).toContain("Spezial");
    expect(checkbox.checked).toBe(true);
    expect(byAriaLabel<HTMLInputElement>(container, "extra Schinken für Margherita")!.checked).toBe(false);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("behält angehakte Kategorien in einer Extras-Zeile", async () => {
    let extras = [{ id: "x-ham", name: "extra Schinken", priceCents: 150, active: true, sortOrder: 1, categoryIds: ["cat-pizza"] }];
    const categories = [
      { id: "cat-pizza", name: "Pizza", sortOrder: 1, active: true, itemCount: 2 },
      { id: "cat-pasta", name: "Pasta", sortOrder: 2, active: true, itemCount: 0 }
    ];
    routes["GET /api/m/pizza/state"] = () => ({ ...openState([margherita]), session: null, myOrder: null, orders: [], guestTotals: [] });
    routes["GET /api/m/pizza/admin/menu"] = () => ({ items: [margherita], categories, extras });
    const container = await render(<PizzaPanel {...props} currentUserRole="manager" />);

    await click(buttonByText(container, "Menü verwalten"));
    const pasta = byAriaLabel<HTMLInputElement>(container, "Kategorie für extra Schinken: Pasta")!;
    const pizza = byAriaLabel<HTMLInputElement>(container, "Kategorie für extra Schinken: Pizza")!;
    await click(pasta);
    await click(pizza);
    const newCategory = byAriaLabel<HTMLInputElement>(container, "Kategorie für neues Extra: Pasta")!;
    await click(newCategory);

    // Ein anderer Manager ändert den Preis desselben Extras
    extras = [{ ...extras[0], priceCents: 200 }];
    await liveSignal("pizza_menu_changed");

    expect(count("GET", "/api/m/pizza/admin/menu")).toBe(2);
    expect(byAriaLabel<HTMLInputElement>(container, "Kategorie für extra Schinken: Pasta")).toBe(pasta);
    expect(pasta.checked).toBe(true);
    expect(pizza.checked).toBe(false);
    expect(newCategory.checked).toBe(true);
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("behält Eingaben im Extras-Editor", async () => {
    let extras = [{ id: "x-ham", name: "extra Schinken", priceCents: 150, active: true, sortOrder: 1, categoryIds: ["cat-pizza"] }];
    const categories = [{ id: "cat-pizza", name: "Pizza", sortOrder: 1, active: true, itemCount: 2 }];
    routes["GET /api/m/pizza/state"] = () => ({ ...openState([margherita]), session: null, myOrder: null, orders: [], guestTotals: [] });
    routes["GET /api/m/pizza/admin/menu"] = () => ({ items: [margherita], categories, extras });
    const container = await render(<PizzaPanel {...props} currentUserRole="manager" />);

    await click(buttonByText(container, "Menü verwalten"));
    const price = byAriaLabel<HTMLInputElement>(container, "Preis in €: extra Schinken")!;
    await type(price, "2,50");
    const fresh = byAriaLabel<HTMLInputElement>(container, "Neues Extra")!;
    await type(fresh, "Knoblauch");

    extras = [...extras, { id: "x-olive", name: "Oliven", priceCents: 80, active: true, sortOrder: 2, categoryIds: ["cat-pizza"] }];
    await liveSignal("pizza_menu_changed");

    expect(container.querySelector('[data-testid="pizza-extra-x-olive"]')).not.toBeNull();
    expect(byAriaLabel<HTMLInputElement>(container, "Preis in €: extra Schinken")).toBe(price);
    expect(price.value).toBe("2,50");
    expect(fresh.value).toBe("Knoblauch");
  });

  it("behält Importtext und Vorschau im Menü-Editor bei fremden Menüänderungen", async () => {
    let adminMenu = [margherita];
    routes["GET /api/m/pizza/state"] = () => ({ ...openState([margherita]), session: null, myOrder: null, orders: [], guestTotals: [] });
    routes["GET /api/m/pizza/admin/menu"] = () => ({ items: adminMenu, categories: [], extras: [] });
    routes["POST /api/m/pizza/admin/menu/transfer/preview"] = () => ({
      format: "yaml",
      sections: { menu: true, extras: true },
      counts: {
        categories: { new: 1, changed: 0, unchanged: 1, removed: 0 },
        items: { new: 2, changed: 0, unchanged: 1, removed: 0 },
        variants: { new: 2, changed: 0, unchanged: 1, removed: 0 },
        extras: { new: 1, changed: 0, unchanged: 0, removed: 0 }
      },
      errors: []
    });
    const container = await render(<PizzaPanel {...props} currentUserRole="manager" />);
    await click(buttonByText(container, "Menü verwalten"));

    const textarea = byAriaLabel<HTMLTextAreaElement>(container, "Inhalt der Importdatei")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "kategorien:\n  - name: Salate\n");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await flushMicrotasks();
    });
    await click(buttonByText(container, "Vorschau"));
    expect(container.querySelector('[data-testid="pizza-transfer-preview"]')).not.toBeNull();

    adminMenu = [margherita, funghi];
    await liveSignal("pizza_menu_changed");

    expect(count("GET", "/api/m/pizza/admin/menu")).toBe(2);
    expect(container.querySelector('[data-testid="pizza-menu-item-pi-002"]')).not.toBeNull();
    expect(byAriaLabel<HTMLTextAreaElement>(container, "Inhalt der Importdatei")).toBe(textarea);
    expect(textarea.value).toBe("kategorien:\n  - name: Salate\n");
    expect(container.querySelector('[data-testid="pizza-transfer-preview"]')).not.toBeNull();
    expect(container.textContent).toContain("Das Menü wurde inzwischen geändert");
    expect(calls.some((call) => call.url.endsWith("/transfer/apply"))).toBe(false);
  });

  it("behält eine angefangene Umbenennung und neue Kategorie im Kategorie-Editor", async () => {
    let categories = [
      { id: "cat-pizza", name: "Pizza", sortOrder: 1, active: true, itemCount: 2 },
      { id: "cat-pasta", name: "Pasta", sortOrder: 2, active: true, itemCount: 0 }
    ];
    routes["GET /api/m/pizza/state"] = () => ({ ...openState([margherita]), session: null, myOrder: null, orders: [], guestTotals: [] });
    routes["GET /api/m/pizza/admin/menu"] = () => ({ items: [margherita], categories });
    const container = await render(<PizzaPanel {...props} currentUserRole="manager" />);

    await click(buttonByText(container, "Menü verwalten"));
    const rename = byAriaLabel<HTMLInputElement>(container, "Name der Kategorie: Pasta")!;
    await type(rename, "Pasta & Aufläufe");
    const fresh = byAriaLabel<HTMLInputElement>(container, "Neue Kategorie")!;
    await type(fresh, "Salate");

    categories = [...categories, { id: "cat-drinks", name: "Getränke", sortOrder: 3, active: true, itemCount: 0 }];
    await liveSignal("pizza_menu_changed");

    expect(count("GET", "/api/m/pizza/admin/menu")).toBe(2);
    expect(container.querySelector('[data-testid="pizza-category-cat-drinks"]')).not.toBeNull();
    expect(byAriaLabel<HTMLInputElement>(container, "Name der Kategorie: Pasta")).toBe(rename);
    expect(rename.value).toBe("Pasta & Aufläufe");
    expect(fresh.value).toBe("Salate");
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("legt Hintergrund-Fehler nicht als Alarm über das Panel und behält den Stand", async () => {
    let fail = false;
    routes["GET /api/m/pizza/state"] = () => {
      if (fail) throw new Error("netz weg");
      return openState([margherita]);
    };
    const container = await render(<PizzaPanel {...props} currentUserRole="user" />);

    fail = true;
    await liveSignal(null);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".pizza-panel__stale")).not.toBeNull();
    expect(container.querySelector(".pizza-line__name")?.textContent).toContain("Margherita");

    fail = false;
    await liveSignal("pizza_line_added");
    expect(container.querySelector(".pizza-panel__stale")).toBeNull();
  });

  it("funkt nicht in eine laufende eigene Aktion, sondern lädt danach einmal", async () => {
    routes["GET /api/m/pizza/state"] = () => openState([margherita]);
    let finishAdd: () => void = () => undefined;
    routes["POST /api/m/pizza/lines"] = () =>
      new Promise((resolve) => {
        finishAdd = () => resolve({ lineId: "l2", orderId: "o1" });
      });
    const container = await render(<PizzaPanel {...props} currentUserRole="user" />);

    await click(buttonByText(container, "Menü öffnen (2 frei)"));
    const variant = Array.from(container.querySelectorAll(".pizza-menu-browser button")).find((button) =>
      button.textContent?.includes("30cm")
    );
    await click(variant);
    expect(count("POST", "/api/m/pizza/lines")).toBe(1);

    await liveSignal("pizza_line_added");
    expect(count("GET", "/api/m/pizza/state")).toBe(1);

    await act(async () => {
      finishAdd();
      await flushMicrotasks();
    });
    expect(count("GET", "/api/m/pizza/state")).toBe(2);
  });

  it("wählt die Bestellrunde pro Event und sperrt Bestellen für Nicht-Teilnehmer", async () => {
    routes["GET /api/main-events"] = () => ({
      mainEvents: [
        { id: "m-1", name: "LAN Herbst", status: "running" },
        { id: "m-2", name: "Alt", status: "ended" }
      ]
    });
    routes["GET /api/m/pizza/state"] = () => ({ ...openState([margherita]), mainEventId: "m-1", canOrder: true });
    routes["GET /api/m/pizza/state?mainEventId=none"] = () => ({
      ...openState([margherita]),
      mainEventId: null,
      canOrder: true
    });
    const container = await render(<PizzaPanel {...props} currentUserRole="user" currentMainEventId="m-1" />);
    const picker = container.querySelector<HTMLSelectElement>(".pizza-panel__scope select")!;
    expect(Array.from(picker.options).map((option) => option.textContent)).toEqual(["Ohne Event", "LAN Herbst"]);
    expect(picker.value).toBe("m-1");
    expect(count("GET", "/api/m/pizza/state")).toBe(1);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(picker, "");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    expect(count("GET", "/api/m/pizza/state?mainEventId=none")).toBe(1);

    routes["GET /api/m/pizza/state?mainEventId=none"] = () => ({
      ...openState([margherita]),
      myOrder: null,
      mainEventId: "m-1",
      mainEventName: "LAN Herbst",
      canOrder: false
    });
    await liveSignal("pizza_session_open");
    expect(container.textContent).toContain("Bestellen können nur Teilnehmer von LAN Herbst");
  });
});
