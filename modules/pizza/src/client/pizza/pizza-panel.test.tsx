/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { requestJson } from "../api/request";
import { I18nProvider } from "../test-support";
import { PizzaPanel } from "./PizzaPanel";
import { PizzaMenuEditor } from "./PizzaMenuEditor";
import { PizzaArchive } from "./PizzaArchive";
import { parseEuroToCents } from "./price";
import type { PizzaCategory, PizzaExtra, PizzaItem, PizzaOrderWithUser, PizzaPanelState } from "./types";

vi.mock("../api/request", () => ({ requestJson: vi.fn() }));

const requestJsonMock = vi.mocked(requestJson);

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function mockApi(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  requestJsonMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = (options?.method ?? "GET").toUpperCase();
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    const call = { url, method, body };
    calls.push(call);
    const handler = routes[`${method} ${url}`];
    if (handler === undefined) return undefined;
    return typeof handler === "function" ? (handler as (call: Call) => unknown)(call) : handler;
  });
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

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text
  );
}

function byAriaLabel<T extends Element>(container: HTMLElement, label: string) {
  return container.querySelector<T>(`[aria-label="${label}"]`);
}

const categories: PizzaCategory[] = [
  { id: "cat-pizza", name: "Pizza", sortOrder: 1, active: true, itemCount: 1 },
  { id: "cat-pasta", name: "Pasta", sortOrder: 2, active: true, itemCount: 0 }
];

const menu: PizzaItem[] = [
  {
    id: "pi-001",
    number: "01",
    name: "Margherita",
    ingredients: null,
    allergens: null,
    categoryId: "cat-pizza",
    active: true,
    sortOrder: 1,
    variants: [
      { id: "v-001-30", itemId: "pi-001", sizeLabel: "30cm", priceCents: 700, sortOrder: 1, active: true }
    ]
  }
];

function order(overrides: Partial<PizzaOrderWithUser> = {}): PizzaOrderWithUser {
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
        variantId: "v-001-30",
        qty: 2,
        priceCentsSnapshot: 700,
        customNote: null,
        createdAt: "2026-10-01T18:00:00.000Z",
        itemNumber: "01",
        itemName: "Margherita",
        sizeLabel: "30cm"
      }
    ],
    ...overrides
  };
}

function panelState(overrides: Partial<PizzaPanelState> = {}): PizzaPanelState {
  const own = order();
  return {
    session: {
      id: "s1",
      state: "locked",
      label: null,
      openedAt: "2026-10-01T18:00:00.000Z",
      lockedAt: null,
      deliveredAt: null
    },
    menu,
    paymentMethods: ["cash", "paypal"],
    myOrder: own,
    orders: [own],
    guestTotals: [{ userId: "u1", totalCents: 1400 }],
    ...overrides
  };
}

const panelProps = {
  currentUserId: "u1",
  paypalHandle: "lanpizza",
  paypalName: "Rene",
  cashRecipient: "Kasse am Eingang"
};

beforeEach(() => {
  calls = [];
  requestJsonMock.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
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
  vi.restoreAllMocks();
});

describe("PizzaPanel – Bezahlart", () => {
  it("lässt Gäste zwischen Bargeld und PayPal wählen", async () => {
    mockApi({ "GET /api/m/pizza/state": panelState() });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);

    const radios = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="pizza-payment-method"]')
    );
    expect(radios.map((radio) => radio.value)).toEqual(["cash", "paypal"]);
    expect(container.textContent).toContain("Bezahlart: noch nicht gewählt");

    await click(radios[0]);
    expect(calls).toContainEqual({
      url: "/api/m/pizza/orders/mine/payment-method",
      method: "POST",
      body: { method: "cash" }
    });
    // Manager-Steuerung ist für normale User nicht sichtbar
    expect(buttonByText(container, "Menü verwalten")).toBeUndefined();
    expect(buttonByText(container, "Runde archivieren")).toBeUndefined();
  });

  it("zeigt bei nur Bargeld keinen PayPal-Link und keine Auswahl", async () => {
    const own = order({ paymentMethod: "cash" });
    mockApi({
      "GET /api/m/pizza/state": panelState({ paymentMethods: ["cash"], myOrder: own, orders: [own] })
    });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);

    expect(container.querySelector('input[name="pizza-payment-method"]')).toBeNull();
    expect(container.textContent).toContain("Bezahlart: Bargeld");
    expect(container.textContent).toContain("Bargeld an: Kasse am Eingang");
    expect(container.querySelector('a[href^="https://www.paypal.me/"]')).toBeNull();
  });

  it("zeigt bei gewähltem PayPal den PayPal-Link mit Betrag", async () => {
    const own = order({ paymentMethod: "paypal" });
    mockApi({ "GET /api/m/pizza/state": panelState({ myOrder: own, orders: [own] }) });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);

    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://www.paypal.me/"]');
    expect(link?.getAttribute("href")).toBe("https://www.paypal.me/lanpizza/14.00EUR");
    expect(container.textContent).not.toContain("Bargeld an:");
  });
});

describe("PizzaPanel – Manager", () => {
  it("bietet in gelieferter Runde Archivieren und Neue Runde an", async () => {
    const delivered = panelState();
    delivered.session = { ...delivered.session!, state: "delivered" };
    mockApi({ "GET /api/m/pizza/state": delivered });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="manager" />);

    expect(buttonByText(container, "Neue Runde starten")).toBeDefined();
    expect(container.textContent).toContain("Bezahlart: noch nicht gewählt");

    await click(buttonByText(container, "Runde archivieren"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Offene Zahlungen: 1"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/sessions/s1/archive",
      method: "POST",
      body: {}
    });

    await click(buttonByText(container, "Neue Runde starten"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/transitions",
      method: "POST",
      body: { transition: "open" }
    });
  });

  it("ändert die Bezahlarten und warnt bei PayPal ohne Handle", async () => {
    mockApi({
      "GET /api/m/pizza/state": panelState({ paymentMode: "paypal_only", paymentMethods: ["cash"] })
    });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="manager" />);
    expect(container.textContent).toContain("kein PayPal-Handle hinterlegt");

    const select = container.querySelector<HTMLSelectElement>(".pizza-panel__payment-mode select")!;
    expect(select.value).toBe("paypal_only");
    await act(async () => {
      select.value = "cash_only";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    expect(calls).toContainEqual({
      url: "/api/m/pizza/payment-mode",
      method: "PUT",
      body: { pizzaPaymentMethods: "cash_only" }
    });
  });

  it("zeigt die Bezahlarten-Auswahl nicht für Gäste", async () => {
    mockApi({ "GET /api/m/pizza/state": panelState({ paymentMode: "cash_and_paypal" }) });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);
    expect(container.querySelector(".pizza-panel__payment-mode")).toBeNull();
  });

  it("archiviert nicht, wenn die Bestätigung abgelehnt wird", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mockApi({ "GET /api/m/pizza/state": panelState() });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="admin" />);
    await click(buttonByText(container, "Runde archivieren"));
    expect(calls.some((call) => call.url.endsWith("/archive"))).toBe(false);
  });

  it("markiert Zahlungen als bar bezahlt", async () => {
    mockApi({ "GET /api/m/pizza/state": panelState() });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="manager" />);
    const group = byAriaLabel<HTMLElement>(container, "Zahlung für Gast");
    await click(Array.from(group!.querySelectorAll("button")).find((b) => b.textContent === "Bar"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/orders/o1/payment",
      method: "POST",
      body: { method: "cash" }
    });
  });

  it("öffnet die Menüverwaltung und das Archiv", async () => {
    mockApi({
      "GET /api/m/pizza/state": panelState({ session: null, myOrder: null, orders: [], guestTotals: [] }),
      "GET /api/m/pizza/admin/menu": { items: menu, categories },
      "GET /api/m/pizza/sessions/archived": { sessions: [] }
    });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="manager" />);
    expect(buttonByText(container, "Runde archivieren")).toBeUndefined();

    await click(buttonByText(container, "Menü verwalten"));
    expect(container.querySelector('[aria-label="Pizza-Menü verwalten"]')).not.toBeNull();
    expect(container.textContent).toContain("1 von 1 Artikeln");

    await click(buttonByText(container, "Archiv anzeigen"));
    expect(container.textContent).toContain("Noch keine archivierten Runden.");
  });
});

describe("PizzaMenuEditor", () => {
  it("ändert Preise und meldet Deaktivieren statt Löschen", async () => {
    mockApi({
      "GET /api/m/pizza/admin/menu": { items: menu, categories },
      "POST /api/m/pizza/admin/variants": { id: "v-001-30" },
      "DELETE /api/m/pizza/admin/variants/v-001-30": { result: "deactivated" }
    });
    const onChanged = vi.fn();
    const container = await render(<PizzaMenuEditor onChanged={onChanged} />);

    await click(byAriaLabel(container, "Bearbeiten: Margherita"));
    const price = byAriaLabel<HTMLInputElement>(container, "Preis in €: Margherita 30cm")!;
    expect(price.value).toBe("7,00");
    await act(async () => {
      setValue(price, "9,50");
      await flushMicrotasks();
    });
    await click(byAriaLabel(container, "Speichern: Margherita 30cm"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/variants",
      method: "POST",
      body: { id: "v-001-30", itemId: "pi-001", sizeLabel: "30cm", priceCents: 950 }
    });
    expect(onChanged).toHaveBeenCalled();

    await click(byAriaLabel(container, "Entfernen: Margherita 30cm"));
    expect(container.textContent).toContain("Wurde schon bestellt – deaktiviert statt gelöscht.");
  });

  it("lehnt ungültige Preise ab und legt neue Artikel an", async () => {
    mockApi({
      "GET /api/m/pizza/admin/menu": { items: menu, categories },
      "POST /api/m/pizza/admin/items": { id: "neu" }
    });
    const container = await render(<PizzaMenuEditor />);

    await click(byAriaLabel(container, "Bearbeiten: Margherita"));
    const newPrice = byAriaLabel<HTMLInputElement>(
      container,
      "Variante hinzufügen Preis in €: Margherita"
    )!;
    await act(async () => {
      setValue(newPrice, "abc");
      await flushMicrotasks();
    });
    await click(buttonByText(container, "Variante hinzufügen"));
    expect(container.textContent).toContain("Bitte einen gültigen Preis eingeben");
    expect(calls.some((call) => call.url === "/api/m/pizza/admin/variants")).toBe(false);

    await click(buttonByText(container, "Neuer Artikel"));
    const form = container.querySelector<HTMLFormElement>(".pizza-menu-editor__form")!;
    const nameInput = Array.from(form.querySelectorAll("label")).find((label) =>
      label.textContent?.startsWith("Name")
    )!.querySelector("input")!;
    await act(async () => {
      setValue(nameInput, "Hausspezial");
      await flushMicrotasks();
    });
    await click(buttonByText(container, "Artikel anlegen"));
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: "/api/m/pizza/admin/items",
        method: "POST",
        body: expect.objectContaining({ name: "Hausspezial", categoryId: "cat-pizza" })
      })
    );
  });
});

describe("PizzaCategoryEditor (im Menü-Editor)", () => {
  it("legt an, benennt um, sortiert, deaktiviert und löscht nur leere Kategorien", async () => {
    mockApi({
      "GET /api/m/pizza/admin/menu": { items: menu, categories },
      "POST /api/m/pizza/admin/categories": { id: "cat-neu" },
      "POST /api/m/pizza/admin/categories/order": undefined,
      "POST /api/m/pizza/admin/categories/cat-pasta/active": undefined,
      "DELETE /api/m/pizza/admin/categories/cat-pasta": undefined
    });
    const container = await render(<PizzaMenuEditor />);
    expect(container.textContent).toContain("Kategorien (2)");

    const newName = byAriaLabel<HTMLInputElement>(container, "Neue Kategorie")!;
    await act(async () => {
      setValue(newName, "Salate");
      await flushMicrotasks();
    });
    await click(buttonByText(container, "Kategorie anlegen"));
    expect(calls).toContainEqual({ url: "/api/m/pizza/admin/categories", method: "POST", body: { name: "Salate" } });

    const rename = byAriaLabel<HTMLInputElement>(container, "Name der Kategorie: Pasta")!;
    await act(async () => {
      setValue(rename, "Pasta & Aufläufe");
      await flushMicrotasks();
    });
    await click(byAriaLabel(container, "Speichern: Pasta"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/categories",
      method: "POST",
      body: { id: "cat-pasta", name: "Pasta & Aufläufe" }
    });

    await click(byAriaLabel(container, "Nach oben: Pasta"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/categories/order",
      method: "POST",
      body: { ids: ["cat-pasta", "cat-pizza"] }
    });
    expect(byAriaLabel<HTMLButtonElement>(container, "Nach oben: Pizza")!.disabled).toBe(true);

    await click(byAriaLabel(container, "Deaktivieren: Pasta"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/categories/cat-pasta/active",
      method: "POST",
      body: { active: false }
    });

    // Pizza enthält Artikel: Löschen gesperrt; Pasta ist leer
    expect(byAriaLabel<HTMLButtonElement>(container, "Löschen: Pizza")!.disabled).toBe(true);
    await click(byAriaLabel(container, "Löschen: Pasta"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Pasta"));
    expect(calls).toContainEqual({ url: "/api/m/pizza/admin/categories/cat-pasta", method: "DELETE", body: undefined });
  });

  it("bietet im Artikel-Formular die Kategorien an", async () => {
    mockApi({ "GET /api/m/pizza/admin/menu": { items: menu, categories } });
    const container = await render(<PizzaMenuEditor />);
    await click(buttonByText(container, "Neuer Artikel"));
    const select = container.querySelector<HTMLSelectElement>(".pizza-menu-editor__form select")!;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Pizza", "Pasta"]);
  });
});

describe("PizzaPanel – Kategorien für Gäste", () => {
  it("gruppiert das Menü nach Kategorie in Sortierreihenfolge", async () => {
    const pasta: PizzaItem = {
      ...menu[0],
      id: "pa-041",
      number: "41",
      name: "Amore",
      categoryId: "cat-pasta",
      variants: [{ id: "v-pa-041", itemId: "pa-041", sizeLabel: null, priceCents: 650, sortOrder: 1, active: true }]
    };
    const own = order({ lines: [] });
    mockApi({
      "GET /api/m/pizza/state": panelState({
        session: { id: "s1", state: "open", label: null, openedAt: null, lockedAt: null, deliveredAt: null },
        categories: [
          { id: "cat-pasta", name: "Pasta", sortOrder: 1 },
          { id: "cat-pizza", name: "Pizza", sortOrder: 2 }
        ],
        menu: [menu[0], pasta],
        myOrder: own,
        orders: []
      })
    });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);
    await click(buttonByText(container, "Menü öffnen (3 frei)"));
    const summaries = Array.from(container.querySelectorAll(".pizza-menu-browser summary")).map(
      (summary) => summary.textContent
    );
    expect(summaries).toEqual(["Pasta (1)", "Pizza (1)"]);
    const details = Array.from(container.querySelectorAll<HTMLDetailsElement>(".pizza-menu-browser details"));
    expect(details.map((detail) => detail.open)).toEqual([true, false]);
  });
});

describe("PizzaPanel – Extras", () => {
  const extras: PizzaExtra[] = [
    { id: "x-ham", name: "extra Schinken", priceCents: 150, active: true, sortOrder: 1, categoryIds: ["cat-pizza"] },
    { id: "x-parm", name: "Parmesan", priceCents: 100, active: true, sortOrder: 2, categoryIds: ["cat-pasta"] }
  ];
  const pasta: PizzaItem = {
    ...menu[0],
    id: "pa-041",
    number: "41",
    name: "Amore",
    categoryId: "cat-pasta",
    variants: [{ id: "v-pa-041", itemId: "pa-041", sizeLabel: null, priceCents: 650, sortOrder: 1, active: true }]
  };
  const openSession = { id: "s1", state: "open" as const, label: null, openedAt: null, lockedAt: null, deliveredAt: null };

  it("bietet im Bestellformular nur Extras der Kategorie an und schickt die Auswahl mit", async () => {
    const own = order({ lines: [] });
    mockApi({
      "GET /api/m/pizza/state": panelState({
        session: openSession,
        categories: categories.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
        menu: [menu[0], pasta],
        extras,
        myOrder: own,
        orders: []
      }),
      "POST /api/m/pizza/lines": { lineId: "l9", orderId: "o1" }
    });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);
    await click(buttonByText(container, "Menü öffnen (3 frei)"));

    const pizzaEntry = container.querySelector<HTMLElement>('[data-testid="pizza-menu-entry-pi-001"]')!;
    const pastaEntry = container.querySelector<HTMLElement>('[data-testid="pizza-menu-entry-pa-041"]')!;
    expect(pizzaEntry.textContent).toContain("extra Schinken (+1,50");
    expect(pizzaEntry.textContent).not.toContain("Parmesan");
    expect(pastaEntry.textContent).toContain("Parmesan");
    expect(pastaEntry.textContent).not.toContain("Schinken");

    await click(byAriaLabel(container, "extra Schinken für Margherita"));
    const variant = Array.from(pizzaEntry.querySelectorAll("button")).find((button) => button.textContent?.includes("30cm"))!;
    expect(variant.textContent?.replace(/\s/g, " ")).toContain("8,50");
    await click(variant);
    expect(calls).toContainEqual({
      url: "/api/m/pizza/lines",
      method: "POST",
      body: { variantId: "v-001-30", qty: 1, customNote: null, extraIds: ["x-ham"] }
    });
    // Nach dem Hinzufügen ist die Auswahl zurückgesetzt
    expect(byAriaLabel<HTMLInputElement>(container, "extra Schinken für Margherita")!.checked).toBe(false);
  });

  it("zeigt Extras mit Aufpreis in Meine Bestellung und ändert sie per Checkbox", async () => {
    const own = order({
      lines: [
        {
          ...order().lines[0],
          categoryId: "cat-pizza",
          extras: [{ extraId: "x-ham", name: "extra Schinken", priceCentsSnapshot: 150 }]
        }
      ]
    });
    mockApi({
      "GET /api/m/pizza/state": panelState({ session: openSession, extras, myOrder: own, orders: [own] }),
      "PATCH /api/m/pizza/lines/l1": undefined
    });
    const container = await render(<PizzaPanel {...panelProps} currentUserRole="user" />);
    const editor = container.querySelector<HTMLElement>(".pizza-panel__editor")!;
    expect(editor.textContent).toContain("+ extra Schinken (+1,50");
    // 2 × (7,00 + 1,50)
    expect(editor.querySelector(".pizza-line__price")?.textContent?.replace(/\s/g, " ")).toContain("17,00");
    expect(container.querySelector(".pizza-overview")?.textContent).toContain("extra Schinken");

    const checkbox = Array.from(editor.querySelectorAll<HTMLInputElement>(".pizza-line__extras-edit input")).find(
      (input) => input.parentElement?.textContent?.includes("extra Schinken")
    )!;
    expect(checkbox.checked).toBe(true);
    await click(checkbox);
    expect(calls).toContainEqual({ url: "/api/m/pizza/lines/l1", method: "PATCH", body: { extraIds: [] } });
  });
});

describe("PizzaExtrasEditor (im Menü-Editor)", () => {
  const extras: PizzaExtra[] = [
    { id: "x-ham", name: "extra Schinken", priceCents: 150, active: true, sortOrder: 1, categoryIds: ["cat-pizza"] }
  ];

  it("legt Extras mit Kategorien an, ändert Preise und deaktiviert bestellte Extras", async () => {
    mockApi({
      "GET /api/m/pizza/admin/menu": { items: menu, categories, extras },
      "POST /api/m/pizza/admin/extras": { id: "x-neu" },
      "DELETE /api/m/pizza/admin/extras/x-ham": { result: "deactivated" }
    });
    const container = await render(<PizzaMenuEditor />);
    expect(container.textContent).toContain("Extras (1)");

    await act(async () => {
      setValue(byAriaLabel<HTMLInputElement>(container, "Neues Extra")!, "Knoblauch");
      setValue(byAriaLabel<HTMLInputElement>(container, "Preis in € für neues Extra")!, "0,50");
      await flushMicrotasks();
    });
    await click(byAriaLabel(container, "Kategorie für neues Extra: Pasta"));
    await click(byAriaLabel(container, "Kategorie für neues Extra: Pizza"));
    await click(buttonByText(container, "Extra anlegen"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/extras",
      method: "POST",
      body: { name: "Knoblauch", priceCents: 50, categoryIds: ["cat-pasta", "cat-pizza"] }
    });

    const price = byAriaLabel<HTMLInputElement>(container, "Preis in €: extra Schinken")!;
    expect(price.value).toBe("1,50");
    await act(async () => {
      setValue(price, "2.00");
      await flushMicrotasks();
    });
    await click(byAriaLabel(container, "Kategorie für extra Schinken: Pasta"));
    await click(byAriaLabel(container, "Speichern: extra Schinken"));
    expect(calls).toContainEqual({
      url: "/api/m/pizza/admin/extras",
      method: "POST",
      body: { id: "x-ham", name: "extra Schinken", priceCents: 200, categoryIds: ["cat-pizza", "cat-pasta"] }
    });

    await click(byAriaLabel(container, "Entfernen: extra Schinken"));
    expect(container.textContent).toContain("Wurde schon bestellt – deaktiviert statt gelöscht.");
  });
});

describe("PizzaArchive", () => {
  it("listet archivierte Runden und löscht nach Bestätigung", async () => {
    mockApi({
      "GET /api/m/pizza/sessions/archived": {
        sessions: [
          {
            id: "alt",
            state: "delivered",
            label: "Mai-LAN",
            createdAt: "2026-05-01T18:00:00.000Z",
            openedAt: "2026-05-01T18:00:00.000Z",
            deliveredAt: "2026-05-01T20:00:00.000Z",
            archivedAt: "2026-05-02T10:00:00.000Z",
            orderCount: 4,
            unpaidCount: 1,
            totalCents: 4200
          }
        ]
      }
    });
    const container = await render(<PizzaArchive />);

    expect(container.textContent).toContain("Mai-LAN");
    expect(container.textContent).toContain("4 Bestellungen");
    const pdf = container.querySelector<HTMLAnchorElement>('a[href*="kassenliste.pdf"]');
    expect(pdf?.getAttribute("href")).toBe("/api/m/pizza/print/kassenliste.pdf?sessionId=alt");

    await click(buttonByText(container, "Endgültig löschen"));
    expect(window.confirm).toHaveBeenCalled();
    expect(calls).toContainEqual({ url: "/api/m/pizza/sessions/alt", method: "DELETE", body: undefined });
  });
});

describe("parseEuroToCents", () => {
  it("parst deutsche und englische Schreibweisen", () => {
    expect(parseEuroToCents("9,50")).toBe(950);
    expect(parseEuroToCents("9.5")).toBe(950);
    expect(parseEuroToCents("12")).toBe(1200);
    expect(parseEuroToCents(" 7,00 € ")).toBe(700);
  });

  it("lehnt ungültige Werte ab", () => {
    expect(parseEuroToCents("")).toBeNull();
    expect(parseEuroToCents("-1")).toBeNull();
    expect(parseEuroToCents("abc")).toBeNull();
    expect(parseEuroToCents("1,234")).toBeNull();
    expect(parseEuroToCents("5000")).toBeNull();
  });
});
