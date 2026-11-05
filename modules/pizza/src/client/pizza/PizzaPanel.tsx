import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage } from "../errors/errors";
import { requestJson } from "../api/request";
import type { MainEvent } from "../types/core";
import { useI18n, type TFunction } from "../i18n/I18nContext";
import { isPizzaReason } from "../realtime/events-changed-bus";
import { useEventsChanged } from "../realtime/use-events-changed";
import {
  addPizzaLine,
  archivePizzaSession,
  choosePizzaPaymentMethod,
  setPizzaPaymentMode,
  deletePizzaLine,
  fetchPizzaState,
  pizzaScopeQuery,
  setPizzaScope,
  markPizzaPayment,
  transitionPizzaSession,
  updatePizzaLine
} from "./api";
import { PizzaArchive } from "./PizzaArchive";
import { PizzaMenuEditor } from "./PizzaMenuEditor";
import { formatEuro, lineTotalCents } from "./price";
import type {
  PizzaCategory,
  PizzaExtra,
  PizzaItem,
  PizzaOrder,
  PizzaOrderLine,
  PizzaOrderWithUser,
  PizzaPanelState,
  PizzaPaymentMethod,
  PizzaPaymentMode,
  PizzaSessionState,
  PizzaSessionTransition,
  PizzaVariant
} from "./types";

interface PizzaPanelProps {
  currentUserId: string;
  currentUserRole: "user" | "organizer" | "manager" | "admin";
  /** Recht `pizza.manage`; fehlt es, gilt die Grundrolle. */
  canManagePizza?: boolean;
  /** Aktuelles Event aus dem globalen Umschalter (Vorauswahl der Bestellrunde). */
  currentMainEventId?: string | null;
  /** Fehlen sie, gelten die Werte aus dem Bestellstatus (`state.payment`). */
  paypalHandle?: string;
  paypalName?: string;
  cashRecipient?: string;
}

function buildPaypalUrl(handle: string, cents: number): string | null {
  const trimmed = handle.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?paypal\.me\//i, "");
  if (!trimmed) return null;
  return `https://www.paypal.me/${encodeURIComponent(trimmed)}/${(cents / 100).toFixed(2)}EUR`;
}

function orderTotal(order: PizzaOrder | null): number {
  if (!order) return 0;
  return order.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}

/** Aktive Extras, die für eine Kategorie angeboten werden. */
function extrasForCategory(extras: PizzaExtra[] | undefined, categoryId: string | null | undefined) {
  if (!categoryId) return [];
  return (extras ?? []).filter((extra) => extra.active !== false && extra.categoryIds.includes(categoryId));
}

/** Extras einer Position mit Aufpreis (Snapshot), z. B. „+ extra Schinken (+1,50 €)“. */
function LineExtrasList({ line }: { line: PizzaOrderLine }) {
  if (!line.extras || line.extras.length === 0) return null;
  return (
    <ul className="pizza-line__extras">
      {line.extras.map((extra) => (
        <li key={extra.extraId}>
          + {extra.name} (+{formatEuro(extra.priceCentsSnapshot)})
        </li>
      ))}
    </ul>
  );
}

function methodLabel(t: TFunction, method: PizzaPaymentMethod | null): string {
  if (method === "cash") return t("pizza.payment.cash");
  if (method === "paypal") return t("pizza.payment.paypal");
  return t("pizza.payment.notChosen");
}

/**
 * Bezahlart, die für die Anzeige gilt: die gewählte, oder die einzig angebotene.
 */
function effectiveMethod(order: PizzaOrder, offered: PizzaPaymentMethod[]): PizzaPaymentMethod | null {
  if (order.paymentMethod) return order.paymentMethod;
  return offered.length === 1 ? offered[0] : null;
}

export function PizzaPanel({
  currentUserId,
  currentUserRole,
  canManagePizza,
  currentMainEventId,
  paypalHandle,
  paypalName,
  cashRecipient
}: PizzaPanelProps) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<PizzaPanelState | null>(null);
  /** Gewählte Bestellrunde: Event-ID oder "" (ohne Event); folgt dem globalen Umschalter. */
  const [scope, setScope] = useState<string>(currentMainEventId ?? "");
  const [openMainEvents, setOpenMainEvents] = useState<MainEvent[]>([]);
  // Ohne Abweichung vom globalen Umschalter nimmt der Server dessen Event (keine Angabe nötig).
  setPizzaScope(scope === (currentMainEventId ?? "") ? undefined : scope || null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  /** Letzter Hintergrund-Abgleich schlug fehl; der bisherige Stand bleibt sichtbar. */
  const [stale, setStale] = useState(false);
  const sync = useRef<{ running: Promise<void> | null; again: boolean; foreground: boolean }>({
    running: null,
    again: false,
    foreground: false
  });
  /** Laufende eigene Aktionen; Live-Signale währenddessen gehen im Reload danach auf. */
  const busy = useRef(0);
  const livePending = useRef(false);

  async function fetchOnce(foreground: boolean) {
    try {
      const next = await fetchPizzaState();
      setState(next);
      setStale(false);
      if (foreground) setError(null);
    } catch (err) {
      // Hintergrund-Fehler nur dezent melden und den bisherigen Stand behalten.
      if (foreground) setError(getErrorMessage(err, locale));
      else setStale(true);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Lädt den Zustand. Nie mehr als ein Request gleichzeitig: Anfragen während eines laufenden
   * Ladevorgangs werden zu genau einem weiteren Durchlauf zusammengefasst. `loading` bleibt
   * dabei unberührt, damit Eingaben in den Kindkomponenten nicht ausgehängt werden.
   */
  function reload(foreground = true): Promise<void> {
    const current = sync.current;
    current.foreground = current.foreground || foreground;
    if (current.running) {
      current.again = true;
      return current.running;
    }
    current.running = (async () => {
      try {
        do {
          current.again = false;
          const asForeground = current.foreground;
          current.foreground = false;
          await fetchOnce(asForeground);
        } while (current.again);
      } finally {
        current.running = null;
      }
    })();
    return current.running;
  }

  async function run(action: () => Promise<unknown>) {
    busy.current += 1;
    let ok = false;
    try {
      await action();
      ok = true;
    } catch (err) {
      setError(getErrorMessage(err, locale));
    } finally {
      busy.current -= 1;
    }
    const pending = livePending.current && busy.current === 0;
    if (pending) livePending.current = false;
    if (ok) await reload(true);
    else if (pending) await reload(false);
    return ok;
  }

  useEffect(() => {
    setScope(currentMainEventId ?? "");
  }, [currentMainEventId]);

  useEffect(() => {
    void reload(true);
  }, [scope]);

  useEffect(() => {
    requestJson<{ mainEvents: MainEvent[] }>("/api/main-events")
      .then((result) => setOpenMainEvents((result?.mainEvents ?? []).filter((entry) => entry.status !== "ended")))
      .catch(() => undefined);
  }, []);

  // Live: `events_changed` mit Grund `pizza_*` (oder ohne Grund) → stiller Abgleich.
  useEventsChanged(() => {
    if (busy.current > 0) {
      livePending.current = true;
      return;
    }
    void reload(false);
  }, isPizzaReason);

  const isManager =
    state?.canManage ?? canManagePizza ?? (currentUserRole === "admin" || currentUserRole === "manager");
  const canManageMenu = state?.canManageMenu ?? isManager;
  const canOrder = state?.canOrder !== false;
  const myTotalCents = useMemo(() => orderTotal(state?.myOrder ?? null), [state]);

  if (loading) return <p className="muted pizza-loading">{t("pizza.panel.loading")}</p>;
  if (!state) return null;

  const session = state.session;
  const sessionState: PizzaSessionState = session?.state ?? "draft";
  const offered = state.paymentMethods ?? ["cash"];

  const scopePicker =
    openMainEvents.length > 0 ? (
      <label className="pizza-panel__scope">
        {t("pizza.scope.label")}
        <select value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="">{t("pizza.scope.none")}</option>
          {openMainEvents.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  if (!isManager && sessionState === "draft") {
    return scopePicker ? (
      <section className="pizza-panel" aria-label={t("pizza.panel.aria")}>
        {scopePicker}
        <p className="muted">{t("pizza.scope.noRound")}</p>
      </section>
    ) : null;
  }

  return (
    <section className="pizza-panel" aria-label={t("pizza.panel.aria")}>
      <header className="pizza-panel__header">
        <h3>
          {session?.label
            ? t("pizza.panel.titleWithLabel", { label: session.label })
            : t("pizza.panel.title")}
        </h3>
        <span className={`pizza-panel__pill pizza-panel__pill--${sessionState}`}>
          {t(`pizza.state.${sessionState}`)}
        </span>
      </header>
      {scopePicker}

      {error ? (
        <p className="pizza-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {stale && !error ? (
        <p className="muted pizza-panel__stale" role="status">
          {t("pizza.panel.stale")}
        </p>
      ) : null}

      {isManager ? (
        <PizzaManagerControls
          state={state}
          onTransition={(transition) => run(() => transitionPizzaSession(transition))}
          onArchive={(sessionId) => run(() => archivePizzaSession(sessionId))}
          onPaymentMode={(mode) => run(() => setPizzaPaymentMode(mode))}
          onMenuChanged={reload}
          canManageMenu={canManageMenu}
        />
      ) : null}

      {sessionState === "open" && !canOrder ? (
        <p className="muted pizza-panel__participants-only">
          {t("pizza.scope.participantsOnly", { name: state.mainEventName ?? "" })}
        </p>
      ) : null}

      {sessionState === "open" && canOrder ? (
        <PizzaOrderEditor
          state={state}
          showMenu={showMenu}
          onToggleMenu={() => setShowMenu((v) => !v)}
          run={run}
        />
      ) : null}

      {state.myOrder && state.myOrder.lines.length > 0 && state.myOrder.paymentStatus === "unpaid" ? (
        <PaymentMethodPicker
          offered={offered}
          value={state.myOrder.paymentMethod}
          onChange={(method) => run(() => choosePizzaPaymentMethod(method))}
        />
      ) : null}

      {(sessionState === "locked" || sessionState === "delivered") && state.myOrder ? (
        <MyShareView
          order={state.myOrder}
          menu={state.menu}
          offered={offered}
          totalCents={myTotalCents}
          paypalHandle={paypalHandle ?? state.payment?.paypalHandle ?? ""}
          paypalName={paypalName ?? state.payment?.paypalName ?? ""}
          cashRecipient={cashRecipient ?? state.payment?.cashRecipient ?? ""}
        />
      ) : null}

      {session && sessionState !== "draft" ? (
        <AllOrdersOverview
          state={state}
          isManager={isManager}
          run={run}
          currentUserId={currentUserId}
        />
      ) : null}
    </section>
  );
}

interface ManagerControlsProps {
  state: PizzaPanelState;
  onTransition: (transition: PizzaSessionTransition) => Promise<unknown>;
  onArchive: (sessionId: string) => Promise<unknown>;
  onPaymentMode: (mode: PizzaPaymentMode) => Promise<unknown>;
  onMenuChanged: () => Promise<void>;
  /** Speisekarte und Bezahlarten nur mit globalem Recht. */
  canManageMenu: boolean;
}

const PAYMENT_MODES: PizzaPaymentMode[] = ["cash_and_paypal", "cash_only", "paypal_only"];

function PizzaManagerControls({
  state,
  onTransition,
  onArchive,
  onPaymentMode,
  onMenuChanged,
  canManageMenu
}: ManagerControlsProps) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"none" | "menu" | "archive">("none");
  const session = state.session;
  const sessionState = session?.state ?? "draft";

  function confirmArchive() {
    if (!session) return;
    const base =
      sessionState === "delivered" || sessionState === "draft"
        ? t("pizza.admin.archiveConfirm")
        : t("pizza.admin.archiveConfirmActive");
    // Archivierte Runden sind eingefroren, auch für Zahlungen: offene Beträge vorher abrechnen.
    const unpaid = state.orders.filter((order) => order.lines.length > 0 && order.paymentStatus === "unpaid").length;
    const message = unpaid > 0 ? `${base}\n\n${t("pizza.admin.archiveUnpaid", { count: unpaid })}` : base;
    if (!window.confirm(message)) return;
    void onArchive(session.id);
  }

  return (
    <>
      <div className="pizza-panel__admin">
        {sessionState === "draft" ? (
          <button type="button" className="primary" onClick={() => onTransition("open")}>
            {t("pizza.admin.open")}
          </button>
        ) : null}
        {sessionState === "open" ? (
          <button type="button" className="primary" onClick={() => onTransition("lock")}>
            {t("pizza.admin.lock")}
          </button>
        ) : null}
        {sessionState === "locked" ? (
          <>
            <button type="button" className="secondary" onClick={() => onTransition("reopen")}>
              {t("pizza.admin.reopen")}
            </button>
            <button type="button" className="primary" onClick={() => onTransition("deliver")}>
              {t("pizza.admin.deliver")}
            </button>
            <a
              className="secondary pizza-panel__pdf-link"
              href={`/api/m/pizza/print/pizzeria.pdf${pizzaScopeQuery()}`}
              target="_blank"
              rel="noreferrer"
            >
              {t("pizza.admin.pdfPizzeria")}
            </a>
          </>
        ) : null}
        {sessionState === "locked" || sessionState === "delivered" ? (
          <a
            className="secondary pizza-panel__pdf-link"
            href={`/api/m/pizza/print/kassenliste.pdf${pizzaScopeQuery()}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("pizza.admin.pdfKasse")}
          </a>
        ) : null}
        {sessionState === "delivered" ? (
          <button type="button" className="primary" onClick={() => onTransition("open")}>
            {t("pizza.admin.newRound")}
          </button>
        ) : null}
        {session ? (
          <button type="button" className="secondary" onClick={confirmArchive}>
            {t("pizza.admin.archive")}
          </button>
        ) : null}
        {canManageMenu ? (
          <button
            type="button"
            className="secondary"
            aria-expanded={panel === "menu"}
            onClick={() => setPanel((current) => (current === "menu" ? "none" : "menu"))}
          >
            {panel === "menu" ? t("pizza.admin.hideMenuEditor") : t("pizza.admin.manageMenu")}
          </button>
        ) : null}
        <button
          type="button"
          className="secondary"
          aria-expanded={panel === "archive"}
          onClick={() => setPanel((current) => (current === "archive" ? "none" : "archive"))}
        >
          {panel === "archive" ? t("pizza.admin.hideArchive") : t("pizza.admin.showArchive")}
        </button>
      </div>
      {state.paymentMode && canManageMenu ? (
        <label className="pizza-panel__payment-mode">
          {t("pizza.admin.paymentMode")}
          <select
            value={state.paymentMode}
            onChange={(event) => void onPaymentMode(event.target.value as PizzaPaymentMode)}
          >
            {PAYMENT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`pizza.admin.paymentMode.${mode}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {state.paymentMode && state.paymentMode !== "cash_only" && !state.paymentMethods.includes("paypal") ? (
        <p className="muted">{t("pizza.admin.paymentModeNoPaypal")}</p>
      ) : null}
      {panel === "menu" && canManageMenu ? <PizzaMenuEditor onChanged={onMenuChanged} /> : null}
      {panel === "archive" ? <PizzaArchive /> : null}
    </>
  );
}

function PaymentMethodPicker({
  offered,
  value,
  onChange
}: {
  offered: PizzaPaymentMethod[];
  value: PizzaPaymentMethod | null;
  onChange: (method: PizzaPaymentMethod) => Promise<unknown>;
}) {
  const { t } = useI18n();
  if (offered.length <= 1) {
    return (
      <p className="muted pizza-payment-picker__only">
        {t("pizza.payment.only", { method: methodLabel(t, offered[0] ?? "cash") })}
      </p>
    );
  }
  return (
    <fieldset className="pizza-payment-picker">
      <legend>{t("pizza.payment.legend")}</legend>
      {offered.map((method) => (
        <label key={method} className="pizza-payment-picker__option">
          <input
            type="radio"
            name="pizza-payment-method"
            value={method}
            checked={value === method}
            onChange={() => void onChange(method)}
          />
          {methodLabel(t, method)}
        </label>
      ))}
    </fieldset>
  );
}

interface OrderEditorProps {
  state: PizzaPanelState;
  showMenu: boolean;
  onToggleMenu: () => void;
  run: (action: () => Promise<unknown>) => Promise<boolean | void>;
}

function PizzaOrderEditor({ state, showMenu, onToggleMenu, run }: OrderEditorProps) {
  const { t } = useI18n();
  const myLines = state.myOrder?.lines ?? [];
  const myTotal = orderTotal(state.myOrder);
  const remaining = 3 - myLines.length;
  // Extras-Auswahl je Artikel-ID hier statt im Menüeintrag: Sie übersteht Live-Abgleiche, auch
  // wenn ein Artikel währenddessen die Kategorie wechselt und sein Eintrag neu gemountet wird.
  const [extraSelections, setExtraSelections] = useState<Record<string, string[]>>({});
  const selectExtras = (itemId: string, update: (current: string[]) => string[]) =>
    setExtraSelections((current) => ({ ...current, [itemId]: update(current[itemId] ?? []) }));

  return (
    <div className="pizza-panel__editor">
      <h4>{t("pizza.editor.title")}</h4>
      {myLines.length === 0 ? (
        <p className="muted">{t("pizza.editor.empty")}</p>
      ) : (
        <ul className="pizza-line-list">
          {myLines.map((line) => (
            <li key={line.id} className="pizza-line">
              <div className="pizza-line__main">
                <span className="pizza-line__name">{lineTitle(t, state.menu, line, true)}</span>
                <span className="pizza-line__price">{formatEuro(lineTotalCents(line))}</span>
              </div>
              <LineExtrasList line={line} />
              <LineExtrasEditor line={line} menu={state.menu} extras={state.extras} run={run} />
              <div className="pizza-line__controls">
                <label>
                  {t("pizza.editor.qty")}
                  <select
                    value={line.qty}
                    onChange={(ev) =>
                      void run(() => updatePizzaLine(line.id, { qty: Number(ev.target.value) }))
                    }
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  className="pizza-line__note"
                  type="text"
                  placeholder={t("pizza.editor.notePlaceholder")}
                  aria-label={t("pizza.editor.notePlaceholder")}
                  defaultValue={line.customNote ?? ""}
                  maxLength={200}
                  onBlur={(ev) => {
                    const value = ev.target.value;
                    if (value === (line.customNote ?? "")) return;
                    void run(() => updatePizzaLine(line.id, { customNote: value }));
                  }}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void run(() => deletePizzaLine(line.id))}
                >
                  {t("pizza.editor.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="pizza-line-list__total">
        {t("pizza.editor.subtotal")} <strong>{formatEuro(myTotal)}</strong>
      </p>

      <div className="pizza-menu-toggle">
        <button type="button" className="secondary" onClick={onToggleMenu} disabled={remaining === 0}>
          {showMenu
            ? t("pizza.editor.hideMenu")
            : remaining === 0
              ? t("pizza.editor.maxReached")
              : t("pizza.editor.openMenu", { count: remaining })}
        </button>
      </div>

      {showMenu && remaining > 0 ? (
        <PizzaMenuBrowser
          menu={state.menu}
          categories={state.categories}
          extras={state.extras}
          selections={extraSelections}
          onSelect={selectExtras}
          onAdd={(variantId, extraIds) => run(() => addPizzaLine({ variantId, qty: 1, extraIds }))}
        />
      ) : null}
    </div>
  );
}

interface MenuGroup {
  id: string;
  name: string;
  items: PizzaItem[];
}

/** Gruppiert das bestellbare Menü nach Kategorie in deren Sortierreihenfolge. */
export function groupMenuByCategory(menu: PizzaItem[], categories: PizzaCategory[] | undefined, fallbackName: string) {
  const sorted = [...(categories ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const groups: MenuGroup[] = sorted.map((category) => ({ id: category.id, name: category.name, items: [] }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  let rest: MenuGroup | null = null;
  for (const item of menu) {
    const group = byId.get(item.categoryId);
    if (group) {
      group.items.push(item);
    } else {
      rest ??= { id: "__rest", name: fallbackName, items: [] };
      rest.items.push(item);
    }
  }
  return [...groups, ...(rest ? [rest] : [])].filter((group) => group.items.length > 0);
}

/**
 * Extras einer bestehenden Position ändern (nur in offener Runde sichtbar). Angeboten werden die
 * aktiven Extras der Kategorie; schon gewählte bleiben abwählbar, auch wenn sie inzwischen
 * deaktiviert sind.
 */
function LineExtrasEditor({
  line,
  menu,
  extras,
  run
}: {
  line: PizzaOrderLine;
  menu: PizzaItem[];
  extras: PizzaExtra[] | undefined;
  run: (action: () => Promise<unknown>) => Promise<boolean | void>;
}) {
  const { t } = useI18n();
  const categoryId = line.categoryId ?? findItem(menu, findVariant(menu, line.variantId)?.itemId ?? "")?.categoryId;
  const selected = (line.extras ?? []).map((extra) => extra.extraId);
  const offered = extrasForCategory(extras, categoryId);
  const options = [
    ...offered.map((extra) => ({ id: extra.id, name: extra.name, priceCents: extra.priceCents })),
    ...(line.extras ?? [])
      .filter((extra) => !offered.some((offer) => offer.id === extra.extraId))
      .map((extra) => ({ id: extra.extraId, name: extra.name, priceCents: extra.priceCentsSnapshot }))
  ];
  if (options.length === 0) return null;

  function toggle(extraId: string, checked: boolean) {
    const next = checked ? [...selected, extraId] : selected.filter((id) => id !== extraId);
    void run(() => updatePizzaLine(line.id, { extraIds: next }));
  }

  return (
    <details className="pizza-line__extras-edit">
      <summary>{t("pizza.extras.change", { count: selected.length })}</summary>
      {options.map((option) => (
        <label key={option.id} className="pizza-extras__option">
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            onChange={(event) => toggle(option.id, event.target.checked)}
          />
          {option.name} (+{formatEuro(option.priceCents)})
        </label>
      ))}
    </details>
  );
}

type ExtraSelections = Record<string, string[]>;
type SelectExtras = (itemId: string, update: (current: string[]) => string[]) => void;

function PizzaMenuBrowser({
  menu,
  categories,
  extras,
  selections,
  onSelect,
  onAdd
}: {
  menu: PizzaItem[];
  categories: PizzaCategory[] | undefined;
  extras: PizzaExtra[] | undefined;
  selections: ExtraSelections;
  onSelect: SelectExtras;
  onAdd: (variantId: string, extraIds: string[]) => Promise<boolean | void>;
}) {
  const { t } = useI18n();
  const groups = groupMenuByCategory(menu, categories, t("pizza.menu.otherCategory"));
  // Nur die beim Öffnen erste Kategorie startet aufgeklappt; spätere Live-Änderungen der
  // Reihenfolge klappen nichts auf oder zu.
  const [initiallyOpen] = useState(() => groups[0]?.id ?? null);
  return (
    <div className="pizza-menu-browser">
      {groups.map((group) => (
        <details key={group.id} open={group.id === initiallyOpen}>
          <summary>{t("pizza.menu.categoryCount", { name: group.name, count: group.items.length })}</summary>
          <PizzaMenuList items={group.items} extras={extras} selections={selections} onSelect={onSelect} onAdd={onAdd} />
        </details>
      ))}
    </div>
  );
}

function PizzaMenuList({
  items,
  extras,
  selections,
  onSelect,
  onAdd
}: {
  items: PizzaItem[];
  extras: PizzaExtra[] | undefined;
  selections: ExtraSelections;
  onSelect: SelectExtras;
  onAdd: (variantId: string, extraIds: string[]) => Promise<boolean | void>;
}) {
  return (
    <ul className="pizza-menu-list">
      {items.map((item) => (
        <PizzaMenuEntry
          key={item.id}
          item={item}
          extras={extrasForCategory(extras, item.categoryId)}
          selected={selections[item.id] ?? []}
          onSelect={(update) => onSelect(item.id, update)}
          onAdd={onAdd}
        />
      ))}
    </ul>
  );
}

/**
 * Ein Artikel im Bestellformular. Die Extras-Auswahl liegt im Bestellformular (je Artikel-ID)
 * und übersteht daher jeden Live-Abgleich; erst das Hinzufügen setzt sie zurück.
 */
function PizzaMenuEntry({
  item,
  extras,
  selected,
  onSelect,
  onAdd
}: {
  item: PizzaItem;
  extras: PizzaExtra[];
  selected: string[];
  onSelect: (update: (current: string[]) => string[]) => void;
  onAdd: (variantId: string, extraIds: string[]) => Promise<boolean | void>;
}) {
  const { t } = useI18n();
  const setSelected = (next: string[] | ((current: string[]) => string[])) =>
    onSelect(typeof next === "function" ? next : () => next);
  // Inzwischen deaktivierte Extras fallen still aus der Auswahl.
  const chosen = selected.filter((id) => extras.some((extra) => extra.id === id));
  const surcharge = extras
    .filter((extra) => chosen.includes(extra.id))
    .reduce((sum, extra) => sum + extra.priceCents, 0);

  function toggle(extraId: string, checked: boolean) {
    setSelected((current) => (checked ? [...current, extraId] : current.filter((id) => id !== extraId)));
  }

  return (
    <li className="pizza-menu-item" data-testid={`pizza-menu-entry-${item.id}`}>
      <div className="pizza-menu-item__head">
        <span className="pizza-menu-item__number">{item.number ?? "—"}</span>
        <span className="pizza-menu-item__name">{item.name}</span>
        {item.allergens ? <span className="pizza-menu-item__allergens">[{item.allergens}]</span> : null}
      </div>
      {item.ingredients ? <p className="pizza-menu-item__ingredients">{item.ingredients}</p> : null}
      {extras.length > 0 ? (
        <fieldset className="pizza-extras">
          <legend>{t("pizza.extras.legend")}</legend>
          {extras.map((extra) => (
            <label key={extra.id} className="pizza-extras__option">
              <input
                type="checkbox"
                checked={chosen.includes(extra.id)}
                aria-label={t("pizza.extras.optionAria", { extra: extra.name, item: item.name })}
                onChange={(event) => toggle(extra.id, event.target.checked)}
              />
              {extra.name} (+{formatEuro(extra.priceCents)})
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="pizza-menu-item__variants">
        {item.variants.map((variant) => (
          <button
            key={variant.id}
            type="button"
            className="secondary"
            onClick={() =>
              void onAdd(variant.id, chosen).then((ok) => {
                if (ok !== false) setSelected([]);
              })
            }
          >
            {variant.sizeLabel ?? t("pizza.menu.standardSize")} · {formatEuro(variant.priceCents + surcharge)}
          </button>
        ))}
      </div>
    </li>
  );
}

function findVariant(menu: PizzaItem[], variantId: string): PizzaVariant | null {
  for (const item of menu) {
    const found = item.variants.find((variant) => variant.id === variantId);
    if (found) return found;
  }
  return null;
}

function findItem(menu: PizzaItem[], itemId: string): PizzaItem | null {
  return menu.find((item) => item.id === itemId) ?? null;
}

/**
 * Bezeichnung einer Bestellzeile. Der Server liefert Name/Größe mit, damit auch deaktivierte
 * Artikel lesbar bleiben; das Menü dient nur als Rückfall.
 */
function lineTitle(t: TFunction, menu: PizzaItem[], line: PizzaOrderLine, withNumber: boolean) {
  const variant = findVariant(menu, line.variantId);
  const item = variant ? findItem(menu, variant.itemId) : null;
  const name = line.itemName ?? item?.name ?? t("pizza.line.removed");
  const number = line.itemNumber !== undefined ? line.itemNumber : (item?.number ?? null);
  const size = line.sizeLabel !== undefined ? line.sizeLabel : (variant?.sizeLabel ?? null);
  return `${withNumber && number ? `${number} ` : ""}${name}${size ? ` (${size})` : ""}`;
}

interface MyShareProps {
  order: PizzaOrder;
  menu: PizzaItem[];
  offered: PizzaPaymentMethod[];
  totalCents: number;
  paypalHandle: string;
  paypalName: string;
  cashRecipient: string;
}

function MyShareView({
  order,
  menu,
  offered,
  totalCents,
  paypalHandle,
  paypalName,
  cashRecipient
}: MyShareProps) {
  const { t } = useI18n();
  const method = effectiveMethod(order, offered);
  const paypalUrl =
    offered.includes("paypal") && method !== "cash" ? buildPaypalUrl(paypalHandle, totalCents) : null;
  const showCash = offered.includes("cash") && method !== "paypal";
  const amount = formatEuro(totalCents);
  return (
    <div className="pizza-my-share">
      <h4>{t("pizza.share.title")}</h4>
      <ul className="pizza-line-list pizza-line-list--readonly">
        {order.lines.map((line) => (
          <li key={line.id} className="pizza-line">
            <span>
              {line.qty}× {lineTitle(t, menu, line, false)}
              {line.customNote ? ` — ${line.customNote}` : ""}
              <LineExtrasList line={line} />
            </span>
            <span>{formatEuro(lineTotalCents(line))}</span>
          </li>
        ))}
      </ul>
      <p className="pizza-my-share__total">
        {t("pizza.share.total")} <strong>{amount}</strong>
      </p>
      <p className="pizza-my-share__status">
        {t("pizza.share.status")}{" "}
        {order.paymentStatus === "unpaid"
          ? t("pizza.share.statusUnpaid")
          : order.paymentStatus === "paid_paypal"
            ? t("pizza.share.statusPaypal")
            : t("pizza.share.statusCash")}
      </p>
      {order.paymentStatus === "unpaid" ? (
        <div className="pizza-my-share__pay">
          {paypalUrl ? (
            <a className="primary" href={paypalUrl} target="_blank" rel="noreferrer">
              {paypalName
                ? t("pizza.share.payPaypalTo", { name: paypalName, amount })
                : t("pizza.share.payPaypal", { amount })}
            </a>
          ) : null}
          {showCash ? (
            <p className="muted">
              {cashRecipient
                ? t("pizza.share.cashTo", { name: cashRecipient })
                : t("pizza.share.cashHint", { amount })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface OverviewProps {
  state: PizzaPanelState;
  isManager: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean | void>;
  currentUserId: string;
}

function AllOrdersOverview({ state, isManager, run, currentUserId }: OverviewProps) {
  const { t } = useI18n();
  if (state.orders.length === 0) {
    return <p className="muted empty-state pizza-overview__empty">{t("pizza.overview.empty")}</p>;
  }
  const offered = state.paymentMethods ?? ["cash"];
  const totalsByUser = new Map(state.guestTotals.map((g) => [g.userId, g.totalCents]));
  const canMark = state.session?.state === "locked" || state.session?.state === "delivered";
  return (
    <div className="pizza-overview">
      <h4>{t("pizza.overview.title", { count: state.orders.length })}</h4>
      <ul className="pizza-overview__list">
        {state.orders.map((order) => {
          const total = totalsByUser.get(order.userId) ?? 0;
          const isMe = order.userId === currentUserId;
          const name = order.user.displayName ?? order.user.username;
          return (
            <li key={order.id} className="pizza-overview__guest">
              <div className="pizza-overview__guest-head">
                <strong>
                  {name}
                  {isMe ? t("pizza.overview.you") : ""}
                </strong>
                <span>{formatEuro(total)}</span>
                <span className="pizza-overview__method">
                  {t("pizza.overview.method", {
                    method: methodLabel(t, effectiveMethod(order, offered))
                  })}
                </span>
                <span className={`pizza-overview__pay-pill pizza-overview__pay-pill--${order.paymentStatus}`}>
                  {paymentLabel(t, order.paymentStatus)}
                </span>
              </div>
              <ul className="pizza-overview__lines">
                {order.lines.map((line) => (
                  <li key={line.id}>
                    {line.qty}× {lineTitle(t, state.menu, line, true)}
                    {line.customNote ? ` — ${line.customNote}` : ""}
                    {" · "}
                    {formatEuro(lineTotalCents(line))}
                    <LineExtrasList line={line} />
                  </li>
                ))}
              </ul>
              {isManager && canMark ? (
                <PaymentControls
                  name={name}
                  current={order.paymentStatus}
                  onMark={(method) => run(() => markPizzaPayment(order.id, method))}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function paymentLabel(t: TFunction, status: PizzaOrderWithUser["paymentStatus"]): string {
  switch (status) {
    case "paid_paypal":
      return t("pizza.overview.paidPaypal");
    case "paid_cash":
      return t("pizza.overview.paidCash");
    default:
      return t("pizza.overview.unpaid");
  }
}

function PaymentControls({
  name,
  current,
  onMark
}: {
  name: string;
  current: PizzaOrderWithUser["paymentStatus"];
  onMark: (method: "paypal" | "cash" | "unpaid") => Promise<unknown>;
}) {
  const { t } = useI18n();
  return (
    <div
      className="pizza-overview__pay-controls"
      role="group"
      aria-label={t("pizza.overview.markAria", { name })}
    >
      <button
        type="button"
        className={current === "paid_cash" ? "primary" : "secondary"}
        aria-pressed={current === "paid_cash"}
        onClick={() => void onMark("cash")}
      >
        {t("pizza.overview.markCash")}
      </button>
      <button
        type="button"
        className={current === "paid_paypal" ? "primary" : "secondary"}
        aria-pressed={current === "paid_paypal"}
        onClick={() => void onMark("paypal")}
      >
        {t("pizza.overview.markPaypal")}
      </button>
      <button
        type="button"
        className="secondary"
        aria-pressed={current === "unpaid"}
        onClick={() => void onMark("unpaid")}
      >
        {t("pizza.overview.markUnpaid")}
      </button>
    </div>
  );
}
