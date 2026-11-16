import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ModuleAdminProps, ModuleClientHost, ModulePageProps } from "@matchdesk/module-sdk";

type Person = { id: string; username: string; displayName: string | null } | null;
type Payment = { method: "cash" | "paypal"; status: "reported" | "confirmed"; reportedAt: string | null; confirmedAt: string | null } | null;
type InstallItem = { id: string; title: string; details: string | null; url: string | null; doneCount: number; doneByMe: boolean };
type BringItem = {
  id: string;
  title: string;
  details: string | null;
  quantity: number | null;
  brought: number;
  mine: number;
  canEdit: boolean;
  claims: Array<{ user: Person; quantity: number }>;
};
type LendItem = {
  id: string;
  title: string;
  details: string | null;
  owner: Person;
  borrowedBy: Person;
  borrowedAt: string | null;
  returnedAt: string | null;
  out: boolean;
  canEdit: boolean;
  canReturn: boolean;
};
type Ride = {
  id: string;
  direction: "there" | "back" | "both";
  startPlace: string;
  departsAt: string | null;
  seats: number;
  free: number;
  note: string | null;
  driver: Person;
  passengers: Person[];
  joined: boolean;
  canEdit: boolean;
};
type Field = {
  id: string;
  label: string;
  kind: "text" | "checkbox" | "choice";
  choices: string[];
  mine: string | null;
  answers?: Array<{ user: Person; value: string }>;
};
type Overview = {
  event: { id: string; name: string; status: string };
  canManage: boolean;
  ended: boolean;
  me: { id: string };
  install: InstallItem[];
  bring: BringItem[];
  lend: LendItem[];
  cost: {
    amountCents: number;
    currency: string;
    note: string | null;
    paypalUrl: string | null;
    dueDate: string | null;
    mine: Payment;
    payments?: Array<{ user: Person; payment: Payment }>;
  } | null;
  rides: Ride[];
  fields: Field[];
};
type EventChoice = { id: string; name: string; status: string; canManage: boolean };
type Tab = "bring" | "install" | "lend" | "cost" | "rides" | "fields";
const TABS: Tab[] = ["bring", "install", "lend", "cost", "rides", "fields"];

/** Filter der Orga-Liste im Beitrag-Reiter. „open" = alles, was noch nicht bestätigt ist. */
type CostFilter = "open" | "reported" | "confirmed" | "all";
const COST_FILTERS: CostFilter[] = ["open", "reported", "confirmed", "all"];
const COST_FILTER_FROM_SEGMENT: Record<string, CostFilter> = {
  offen: "open",
  open: "open",
  gemeldet: "reported",
  reported: "reported",
  "bestätigt": "confirmed",
  bestaetigt: "confirmed",
  confirmed: "confirmed",
  alle: "all",
  all: "all"
};
/**
 * Liest den Listenfilter aus dem Pfad (z. B. `.../beitrag/offen`). Die eigentliche Pfadlogik kommt
 * in AP5; hier wird der Filter nur aus `subPath` lesbar gemacht, damit AP5 ihn nur noch verdrahtet.
 * Ohne passendes Segment gilt die Vorgabe „Offen".
 */
function costFilterFromSubPath(subPath: string): CostFilter {
  const segments = subPath.split("/").map((segment) => segment.trim().toLowerCase()).filter(Boolean);
  for (const segment of segments) {
    const match = COST_FILTER_FROM_SEGMENT[segment];
    if (match) return match;
  }
  return "open";
}
/** Zustand einer Zahlung: offen (nichts gemeldet), gemeldet, bestätigt. */
type CostState = "open" | "reported" | "confirmed";
const paymentState = (payment: Payment): CostState => (!payment ? "open" : payment.status === "confirmed" ? "confirmed" : "reported");
const COST_STATE_ORDER: Record<CostState, number> = { reported: 0, open: 1, confirmed: 2 };

/**
 * Teilt die Verleihliste in die Gruppen des Verleih-Reiters (Konzept HCI-153 Abschnitt 2.4):
 * „Du hast ausgeliehen", „Frei" (nach Name sortiert), „Deine Angebote" und am Ende zusammengefasst
 * die Sachen anderer, die gerade an jemand anderen verliehen sind.
 */
export function groupLendItems(items: LendItem[], meId: string, locale?: string) {
  const byTitle = (a: LendItem, b: LendItem) => a.title.localeCompare(b.title, locale, { sensitivity: "base" });
  const borrowed: LendItem[] = [];
  const free: LendItem[] = [];
  const offers: LendItem[] = [];
  const lentToOthers: LendItem[] = [];
  for (const item of items) {
    if (item.owner?.id === meId) offers.push(item);
    else if (item.out && item.borrowedBy?.id === meId) borrowed.push(item);
    else if (!item.out) free.push(item);
    else lentToOthers.push(item);
  }
  return { borrowed: borrowed.sort(byTitle), free: free.sort(byTitle), offers: offers.sort(byTitle), lentToOthers: lentToOthers.sort(byTitle) };
}

export default function createModule(host: ModuleClientHost) {
  const { t, api } = host;
  const name = (person: Person) => (person ? person.displayName || person.username : "–");
  const money = (cents: number, currency: string) => new Intl.NumberFormat(host.locale, { style: "currency", currency }).format(cents / 100);
  const when = (value: string) =>
    new Date(value).toLocaleString(host.locale, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const shortDateTime = (value: string) =>
    new Date(value).toLocaleString(host.locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  /** Frist im Klartext: „Zahlen bis Dienstag, 10.11.2026" plus Rest („noch 4 Tage" / „überfällig"). */
  const dueInfo = (dueDate: string) => {
    const [year, month, day] = dueDate.split("-").map(Number);
    const due = new Date(year, month - 1, day);
    const weekday = due.toLocaleDateString(host.locale, { weekday: "long" });
    const date = due.toLocaleDateString(host.locale);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
    const rel = days > 1 ? t("cost.daysLeftOther", { days }) : days === 1 ? t("cost.daysLeftOne") : days === 0 ? t("cost.dueToday") : t("cost.overdue");
    return { clear: t("cost.dueClear", { weekday, date }), rel };
  };

  /** Führt eine Änderung aus; true, wenn sie geklappt hat (Fehler stehen dann schon oben auf der Seite). */
  type Run = (path: string, init?: RequestInit) => Promise<boolean>;

  function Section({ title, children }: { title: string; children: ReactNode }) {
    // min-width:0, damit die rollbare Reiterleiste (.tab-strip) und das .status-grid auf 390 px nicht
    // breiter als der Bildschirm werden. Der Kern setzt min-width:0 nur auf dem äußeren Modul-<section>
    // (.page-card > section), nicht auf diesem verschachtelten Grid-Kind.
    return (
      <section className="extras-section" style={{ minWidth: 0 }}>
        <h3>{title}</h3>
        {children}
      </section>
    );
  }

  function AddItem({ list, run, withUrl, withQuantity, submitLabel }: { list: "install" | "bring" | "lend"; run: Run; withUrl?: boolean; withQuantity?: boolean; submitLabel?: string }) {
    const [draft, setDraft] = useState({ title: "", details: "", url: "", quantity: "" });
    function submit(event: FormEvent) {
      event.preventDefault();
      void run("/events/__EVENT__/items", {
        method: "POST",
        body: JSON.stringify({
          list,
          title: draft.title.trim(),
          details: draft.details.trim() || null,
          url: withUrl && draft.url.trim() ? draft.url.trim() : null,
          quantity: withQuantity && draft.quantity ? Number(draft.quantity) : null
        })
      }).then((ok) => ok && setDraft({ title: "", details: "", url: "", quantity: "" }));
    }
    return (
      <form className="admin-form inline-form" onSubmit={submit}>
        <input required maxLength={120} value={draft.title} placeholder={t(`${list}.titlePlaceholder`)} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        {withUrl ? <input type="url" maxLength={500} value={draft.url} placeholder="https://…" onChange={(e) => setDraft({ ...draft, url: e.target.value })} /> : null}
        {withQuantity ? (
          <input type="number" min={1} max={999} value={draft.quantity} placeholder={t("bring.quantity")} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
        ) : null}
        <input maxLength={1000} value={draft.details} placeholder={t("common.details")} onChange={(e) => setDraft({ ...draft, details: e.target.value })} />
        <button type="submit" disabled={!draft.title.trim()}>
          {submitLabel ?? t("common.add")}
        </button>
      </form>
    );
  }

  function BringTab({ data, run }: { data: Overview; run: Run }) {
    return (
      <Section title={t("tab.bring")}>
        <p className="muted">{t("bring.intro")}</p>
        {data.bring.length === 0 ? <p className="muted">{t("common.empty")}</p> : null}
        <ul className="device-list">
          {data.bring.map((item) => (
            <li key={item.id} className="device-row">
              <div>
                <p>
                  <strong>{item.title}</strong>
                  {item.quantity ? ` · ${t("bring.progress", { brought: item.brought, needed: item.quantity })}` : ` · ${t("bring.count", { brought: item.brought })}`}
                </p>
                {item.details ? <small className="muted">{item.details}</small> : null}
                {item.claims.length > 0 ? (
                  <small className="muted"> {item.claims.map((claim) => `${name(claim.user)}${claim.quantity > 1 ? ` ×${claim.quantity}` : ""}`).join(", ")}</small>
                ) : null}
              </div>
              {!data.ended ? (
                <span>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    aria-label={t("bring.mine")}
                    defaultValue={item.mine}
                    key={`${item.id}-${item.mine}`}
                    onBlur={(e) => {
                      const quantity = Math.max(0, Number(e.target.value) || 0);
                      if (quantity !== item.mine) void run(`/items/${item.id}/bring`, { method: "PUT", body: JSON.stringify({ quantity }) });
                    }}
                    style={{ width: "4.5em" }}
                  />{" "}
                  {item.mine === 0 ? (
                    <button type="button" className="secondary" onClick={() => run(`/items/${item.id}/bring`, { method: "PUT", body: JSON.stringify({ quantity: 1 }) })}>
                      {t("bring.iBring")}
                    </button>
                  ) : null}
                  {item.canEdit ? (
                    <button type="button" className="secondary danger" onClick={() => run(`/items/${item.id}`, { method: "DELETE" })}>
                      {t("common.remove")}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {!data.ended ? <AddItem list="bring" run={run} withQuantity={data.canManage} /> : null}
      </Section>
    );
  }

  function InstallTab({ data, run }: { data: Overview; run: Run }) {
    return (
      <Section title={t("tab.install")}>
        <p className="muted">{t("install.intro")}</p>
        {data.install.length === 0 ? <p className="muted">{t("common.empty")}</p> : null}
        <ul className="device-list">
          {data.install.map((item) => (
            <li key={item.id} className="device-row">
              <label className="checkbox-row">
                <input type="checkbox" checked={item.doneByMe} onChange={(e) => run(`/items/${item.id}/done`, { method: "PUT", body: JSON.stringify({ done: e.target.checked }) })} />
                <span>
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer noopener">
                      {item.title}
                    </a>
                  ) : (
                    item.title
                  )}
                  {item.details ? <small className="muted"> {item.details}</small> : null}
                  <small className="muted"> · {t("install.done", { count: item.doneCount })}</small>
                </span>
              </label>
              {data.canManage ? (
                <button type="button" className="secondary danger" onClick={() => run(`/items/${item.id}`, { method: "DELETE" })}>
                  {t("common.remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {data.canManage && !data.ended ? <AddItem list="install" run={run} withUrl /> : null}
      </Section>
    );
  }

  /** Zustand eines Verleih-Eintrags als Badge: frei grün, bei dir / verliehen amber, zurückgegeben neutral. */
  function LendBadge({ item, meId }: { item: LendItem; meId: string }) {
    if (item.out && item.borrowedBy?.id === meId) return <span className="badge badge--warn">{t("lend.badgeWithYou")}</span>;
    if (item.out) return <span className="badge badge--warn">{t("lend.out", { name: name(item.borrowedBy) })}</span>;
    if (item.returnedAt && item.owner?.id === meId) return <span className="badge">{t("lend.badgeReturned")}</span>;
    return <span className="badge badge--ok">{t("lend.available")}</span>;
  }

  function LendRow({ item, data, run }: { item: LendItem; data: Overview; run: Run }) {
    const mine = item.owner?.id === data.me.id;
    const sub: string[] = [];
    if (!mine) sub.push(t("lend.from", { name: name(item.owner) }));
    if (item.out && item.borrowedAt) sub.push(t("lend.since", { when: shortDateTime(item.borrowedAt) }));
    if (mine && !item.out) sub.push(item.returnedAt ? t("lend.returned", { name: name(item.borrowedBy) }) : t("lend.nobody"));
    if (item.details) sub.push(item.details);
    // Zurückgeben hängt nur an canReturn (Server), nicht am Eventstatus: geht auch nach Eventende.
    const canBorrow = !item.out && !data.ended && !mine;
    return (
      <li className="device-row">
        <div>
          <p className="item-title">
            <strong>{item.title}</strong> <LendBadge item={item} meId={data.me.id} />
          </p>
          {sub.length > 0 ? <p className="item-sub">{sub.join(" · ")}</p> : null}
        </div>
        {canBorrow || item.canReturn || (item.canEdit && !item.out) ? (
          <div className="device-actions">
            {canBorrow ? (
              <button type="button" className="secondary" onClick={() => run(`/items/${item.id}/borrow`, { method: "POST", body: "{}" })}>
                {t("lend.borrow")}
              </button>
            ) : null}
            {item.canReturn ? (
              <button type="button" className="secondary" onClick={() => run(`/items/${item.id}/return`, { method: "POST", body: "{}" })}>
                {t("lend.return")}
              </button>
            ) : null}
            {item.canEdit && !item.out ? (
              <button type="button" className="secondary danger" onClick={() => run(`/items/${item.id}`, { method: "DELETE" })}>
                {t("common.remove")}
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  }

  function LendGroup({ group, title, items, data, run, empty }: { group: string; title: string; items: LendItem[]; data: Overview; run: Run; empty?: string }) {
    if (items.length === 0 && !empty) return null;
    return (
      <div className="lend-group" data-group={group}>
        <h4>{t("lend.groupTitle", { title, count: items.length })}</h4>
        {items.length === 0 ? (
          <p className="muted">{empty}</p>
        ) : (
          <ul className="device-list">
            {items.map((item) => (
              <LendRow key={item.id} item={item} data={data} run={run} />
            ))}
          </ul>
        )}
      </div>
    );
  }

  function LendTab({ data, run }: { data: Overview; run: Run }) {
    const groups = groupLendItems(data.lend, data.me.id, host.locale);
    return (
      <Section title={t("tab.lend")}>
        <p className="muted">{t("lend.intro")}</p>
        {data.lend.length === 0 ? (
          <p className="muted">{t("lend.empty")}</p>
        ) : (
          <>
            <LendGroup group="borrowed" title={t("lend.groupBorrowed")} items={groups.borrowed} data={data} run={run} />
            <LendGroup group="free" title={t("lend.groupFree")} items={groups.free} data={data} run={run} empty={t("lend.freeEmpty")} />
            <LendGroup group="offers" title={t("lend.groupOffers")} items={groups.offers} data={data} run={run} />
            {groups.lentToOthers.length > 0 ? (
              <details className="more-info lend-group" data-group="lentToOthers">
                <summary>{t("lend.groupTitle", { title: t("lend.groupLentToOthers"), count: groups.lentToOthers.length })}</summary>
                <ul className="device-list">
                  {groups.lentToOthers.map((item) => (
                    <LendRow key={item.id} item={item} data={data} run={run} />
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
        {!data.ended ? (
          <details className="more-info">
            <summary>{t("lend.offer")}</summary>
            <AddItem list="lend" run={run} submitLabel={t("lend.offerSubmit")} />
          </details>
        ) : null}
      </Section>
    );
  }

  /** Badge für den eigenen Zahlungsstand (Teilnehmer-Sicht): offen/gemeldet amber, bestätigt grün. */
  function MyBadge({ state }: { state: CostState }) {
    if (state === "confirmed") return <span className="badge badge--ok">{t("cost.badgeConfirmed")}</span>;
    if (state === "reported") return <span className="badge badge--warn">{t("cost.badgeReported")}</span>;
    return <span className="badge badge--warn">{t("cost.open")}</span>;
  }

  /** Badge einer Orga-Listenzeile: offen neutral, gemeldet amber, bestätigt grün; mit Zahlart. */
  function RowBadge({ payment }: { payment: Payment }) {
    const state = paymentState(payment);
    if (state === "confirmed") return <span className="badge badge--ok">{t("cost.rowConfirmed", { method: t(`cost.${payment!.method}`) })}</span>;
    if (state === "reported") return <span className="badge badge--warn">{t("cost.rowReported", { method: t(`cost.${payment!.method}`) })}</span>;
    return <span className="badge">{t("cost.open")}</span>;
  }

  function CostEditForm({ cost, draft, setDraft, save, run }: { cost: Overview["cost"]; draft: { amount: string; note: string; paypalUrl: string; dueDate: string }; setDraft: (value: { amount: string; note: string; paypalUrl: string; dueDate: string }) => void; save: (event: FormEvent) => void; run: Run }) {
    return (
      <form className="admin-form" onSubmit={save}>
        <label>
          {t("cost.setAmount")}
          <input required inputMode="decimal" pattern="\d+([.,]\d{1,2})?" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
        </label>
        <label>
          {t("cost.paypalUrl")}
          <input type="url" placeholder="https://paypal.me/…" value={draft.paypalUrl} onChange={(e) => setDraft({ ...draft, paypalUrl: e.target.value })} />
        </label>
        <label>
          {t("cost.dueDate")}
          <input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
        </label>
        <label>
          {t("common.details")}
          <input maxLength={500} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </label>
        <button type="submit">{t("common.save")}</button>{" "}
        {cost ? (
          <button
            type="button"
            className="secondary danger"
            onClick={() => {
              if (window.confirm(t("cost.deleteConfirm"))) void run("/events/__EVENT__/cost", { method: "DELETE" });
            }}
          >
            {t("cost.delete")}
          </button>
        ) : null}
      </form>
    );
  }

  function CostTab({ data, run, initialFilter }: { data: Overview; run: Run; initialFilter: CostFilter }) {
    const cost = data.cost;
    const [filter, setFilter] = useState<CostFilter>(initialFilter);
    const [draft, setDraft] = useState({
      amount: cost ? String(cost.amountCents / 100) : "",
      note: cost?.note ?? "",
      paypalUrl: cost?.paypalUrl ?? "",
      dueDate: cost?.dueDate ?? ""
    });
    function save(event: FormEvent) {
      event.preventDefault();
      void run("/events/__EVENT__/cost", {
        method: "PUT",
        body: JSON.stringify({
          amountCents: Math.round(Number(draft.amount.replace(",", ".")) * 100),
          note: draft.note.trim() || null,
          paypalUrl: draft.paypalUrl.trim() || null,
          dueDate: draft.dueDate || null
        })
      });
    }

    if (!cost) {
      return (
        <Section title={t("tab.cost")}>
          <p className="muted">{t("cost.none")}</p>
          {data.canManage ? (
            <>
              <p className="muted">{t("cost.manageHint")}</p>
              <CostEditForm cost={cost} draft={draft} setDraft={setDraft} save={save} run={run} />
            </>
          ) : null}
        </Section>
      );
    }

    const mineState = paymentState(cost.mine);
    const due = cost.dueDate ? dueInfo(cost.dueDate) : null;

    // Kennzahlen und gefilterte Liste (nur Orga).
    const payments = cost.payments ?? [];
    const total = payments.length;
    const confirmedCount = payments.filter((entry) => paymentState(entry.payment) === "confirmed").length;
    const reportedCount = payments.filter((entry) => paymentState(entry.payment) === "reported").length;
    const nothingCount = payments.filter((entry) => paymentState(entry.payment) === "open").length;
    const openCount = reportedCount + nothingCount; // „noch nicht bezahlt" = alles außer bestätigt
    const counts: Record<CostFilter, number> = { open: openCount, reported: reportedCount, confirmed: confirmedCount, all: total };
    const matchesFilter = (state: CostState) =>
      filter === "all" ? true : filter === "open" ? state !== "confirmed" : state === filter;
    const rows = payments
      .filter((entry) => matchesFilter(paymentState(entry.payment)))
      .slice()
      .sort((a, b) => {
        const order = COST_STATE_ORDER[paymentState(a.payment)] - COST_STATE_ORDER[paymentState(b.payment)];
        return order !== 0 ? order : name(a.user).localeCompare(name(b.user), host.locale);
      });

    // Teilnehmer-Sicht: Betrag, Zustand, Frist, Zweck und die eigenen Knöpfe.
    // Immer sichtbar – auch für die Orga, die selbst Teilnehmer ist und ihren
    // eigenen Beitrag zahlen muss (Konzept HCI-153 Abschnitt 2.6, additiv).
    const participantView = (
      <>
        {/* Kopfbereich: Betrag, Zustand, Frist, Zweck */}
        <div className="inline-form">
          <p className="item-title">
            <strong>{t("cost.amountPerPerson", { amount: money(cost.amountCents, cost.currency) })}</strong> <MyBadge state={mineState} />
          </p>
          {due ? (
            <p className="item-sub">
              {due.clear} · {due.rel}
            </p>
          ) : null}
          {cost.note ? <p className="item-sub">{cost.note}</p> : null}
        </div>

        {/* Dein Beitrag: Zustand und Knöpfe */}
        <div className="device-row">
          <div>
            <p className="item-title">
              <strong>{t("cost.myTitle")}</strong> <MyBadge state={mineState} />
            </p>
            <span>
              {mineState === "open"
                ? t("cost.myOpen")
                : mineState === "reported"
                  ? t("cost.myReported", { method: t(`cost.${cost.mine!.method}`), when: cost.mine!.reportedAt ? shortDateTime(cost.mine!.reportedAt) : "" })
                  : t("cost.myConfirmed")}
            </span>
          </div>
          {mineState !== "confirmed" ? (
            <div className="device-actions">
              {cost.paypalUrl ? (
                <a className="button-link secondary" href={cost.paypalUrl} target="_blank" rel="noreferrer noopener">
                  {t("cost.payPaypal")}
                </a>
              ) : null}
              <button type="button" className="secondary" onClick={() => run("/events/__EVENT__/payment", { method: "PUT", body: JSON.stringify({ method: "paypal" }) })}>
                {t("cost.reportPaypal")}
              </button>
              <button type="button" className="secondary" onClick={() => run("/events/__EVENT__/payment", { method: "PUT", body: JSON.stringify({ method: "cash" }) })}>
                {t("cost.reportCash")}
              </button>
              {cost.mine ? (
                <button type="button" className="secondary danger" onClick={() => run("/events/__EVENT__/payment", { method: "PUT", body: JSON.stringify({ method: null }) })}>
                  {t("cost.withdraw")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {mineState !== "confirmed" ? <p className="item-sub">{t("cost.nextStep")}</p> : null}
      </>
    );

    // Orga-Sicht: Kennzahlen, Filter, Liste, Formular.
    const orgaView =
      data.canManage && cost.payments ? (
        <>
          <dl className="status-grid">
            <div>
              <dt>{t("cost.statConfirmed")}</dt>
              <dd>{t("cost.statConfirmedValue", { confirmed: confirmedCount, total })}</dd>
            </div>
            <div>
              <dt>{t("cost.statReported")}</dt>
              <dd>{reportedCount}</dd>
            </div>
            <div>
              <dt>{t("cost.statNothing")}</dt>
              <dd>{nothingCount}</dd>
            </div>
            <div>
              <dt>{t("cost.statCollected")}</dt>
              <dd>{t("cost.statCollectedValue", { collected: money(confirmedCount * cost.amountCents, cost.currency), expected: money(total * cost.amountCents, cost.currency) })}</dd>
            </div>
          </dl>

          <div className="tab-strip tab-strip--filter" role="tablist" aria-label={t("cost.filterLabel")}>
            {COST_FILTERS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={filter === entry}
                className={filter === entry ? "tab-strip__tab active" : "tab-strip__tab"}
                onClick={() => setFilter(entry)}
              >
                {t(`cost.filter.${entry}`, { count: counts[entry] })}
              </button>
            ))}
          </div>

          {rows.length === 0 ? <p className="muted">{t("cost.listEmpty")}</p> : null}
          <ul className="device-list">
            {rows.map((entry) => {
              const state = paymentState(entry.payment);
              return (
                <li key={entry.user?.id} className="device-row">
                  <div>
                    <p className="item-title">
                      <strong>{name(entry.user)}</strong> <RowBadge payment={entry.payment} />
                    </p>
                    <span>
                      {state === "open"
                        ? t("cost.rowNothing")
                        : state === "reported"
                          ? t("cost.rowReportedAt", { when: entry.payment!.reportedAt ? shortDateTime(entry.payment!.reportedAt) : "" })
                          : t("cost.rowConfirmedAt", { when: entry.payment!.confirmedAt ? shortDateTime(entry.payment!.confirmedAt) : "" })}
                    </span>
                  </div>
                  <div className="device-actions">
                    {state === "reported" ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => run(`/events/__EVENT__/payments/${entry.user?.id}`, { method: "PUT", body: JSON.stringify({ status: "confirmed", method: entry.payment?.method ?? "cash" }) })}
                      >
                        {t("cost.confirm")}
                      </button>
                    ) : null}
                    {state === "open" ? (
                      <button type="button" className="secondary" onClick={() => run(`/events/__EVENT__/payments/${entry.user?.id}`, { method: "PUT", body: JSON.stringify({ status: "confirmed", method: "cash" }) })}>
                        {t("cost.confirmCash")}
                      </button>
                    ) : null}
                    {state === "confirmed" ? (
                      <button type="button" className="secondary" onClick={() => run(`/events/__EVENT__/payments/${entry.user?.id}`, { method: "PUT", body: JSON.stringify({ status: "open" }) })}>
                        {t("cost.reset")}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          <details className="more-info">
            <summary>{t("cost.edit")}</summary>
            <CostEditForm cost={cost} draft={draft} setDraft={setDraft} save={save} run={run} />
          </details>
        </>
      ) : null;

    // Reihenfolge: Für die Orga stehen die Kennzahlen und der Filter „Offen" zuerst
    // (Konzept HCI-153 Abschnitt 2.4 „zuerst … Kennzahlen"), damit „wer hat noch nicht
    // bezahlt" bei 25 Personen auch auf 390 px ohne Scrollen oberhalb der unteren
    // Navigation sichtbar ist. Der eigene Beitrag folgt darunter. Teilnehmer ohne
    // Verwaltungsrecht sehen nur ihre eigene Sicht.
    return (
      <Section title={t("tab.cost")}>
        {data.canManage ? (
          <>
            {orgaView}
            {participantView}
          </>
        ) : (
          participantView
        )}
      </Section>
    );
  }

  function RidesTab({ data, run }: { data: Overview; run: Run }) {
    const [draft, setDraft] = useState({ direction: "there", startPlace: "", departsAt: "", seats: "3", note: "" });
    function offer(event: FormEvent) {
      event.preventDefault();
      void run("/events/__EVENT__/rides", {
        method: "POST",
        body: JSON.stringify({
          direction: draft.direction,
          startPlace: draft.startPlace.trim(),
          departsAt: draft.departsAt ? new Date(draft.departsAt).toISOString() : null,
          seats: Number(draft.seats),
          note: draft.note.trim() || null
        })
      }).then((ok) => ok && setDraft({ ...draft, startPlace: "", departsAt: "", note: "" }));
    }
    return (
      <Section title={t("tab.rides")}>
        {data.rides.length === 0 ? <p className="muted">{t("rides.empty")}</p> : null}
        <ul className="device-list">
          {data.rides.map((ride) => (
            <li key={ride.id} className="device-row">
              <div>
                <p>
                  <strong>{t(`rides.direction.${ride.direction}`)}</strong> · {ride.startPlace}
                  {ride.departsAt ? ` · ${when(ride.departsAt)}` : ""} · {t("rides.driver", { name: name(ride.driver) })}
                </p>
                <small className="muted">
                  {t("rides.free", { free: ride.free, seats: ride.seats })}
                  {ride.passengers.length > 0 ? ` · ${ride.passengers.map(name).join(", ")}` : ""}
                  {ride.note ? ` · ${ride.note}` : ""}
                </small>
              </div>
              <span>
                {!data.ended && ride.driver?.id !== data.me.id ? (
                  ride.joined ? (
                    <button type="button" className="secondary" onClick={() => run(`/rides/${ride.id}/seat`, { method: "DELETE" })}>
                      {t("rides.leave")}
                    </button>
                  ) : ride.free > 0 ? (
                    <button type="button" onClick={() => run(`/rides/${ride.id}/seat`, { method: "PUT", body: "{}" })}>
                      {t("rides.join")}
                    </button>
                  ) : null
                ) : null}
                {ride.canEdit ? (
                  <button type="button" className="secondary danger" onClick={() => run(`/rides/${ride.id}`, { method: "DELETE" })}>
                    {t("common.remove")}
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {!data.ended ? (
          <details>
            <summary>{t("rides.offer")}</summary>
            <form className="admin-form" onSubmit={offer}>
              <label>
                {t("rides.directionLabel")}
                <select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value })}>
                  {(["there", "back", "both"] as const).map((direction) => (
                    <option key={direction} value={direction}>
                      {t(`rides.direction.${direction}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("rides.startPlace")}
                <input required maxLength={120} value={draft.startPlace} onChange={(e) => setDraft({ ...draft, startPlace: e.target.value })} />
              </label>
              <label>
                {t("rides.departsAt")}
                <input type="datetime-local" value={draft.departsAt} onChange={(e) => setDraft({ ...draft, departsAt: e.target.value })} />
              </label>
              <label>
                {t("rides.seats")}
                <input type="number" min={1} max={8} required value={draft.seats} onChange={(e) => setDraft({ ...draft, seats: e.target.value })} />
              </label>
              <label>
                {t("common.details")}
                <input maxLength={500} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              </label>
              <button type="submit" disabled={!draft.startPlace.trim()}>
                {t("rides.offerSubmit")}
              </button>
            </form>
          </details>
        ) : null}
      </Section>
    );
  }

  function FieldsTab({ data, run }: { data: Overview; run: Run }) {
    const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(data.fields.map((field) => [field.id, field.mine ?? ""])));
    const [draft, setDraft] = useState({ label: "", kind: "text", choices: "" });
    useEffect(() => setAnswers(Object.fromEntries(data.fields.map((field) => [field.id, field.mine ?? ""]))), [data.fields]);

    function saveAnswers(event: FormEvent) {
      event.preventDefault();
      void run("/events/__EVENT__/answers", { method: "PUT", body: JSON.stringify({ answers }) });
    }
    function addField(event: FormEvent) {
      event.preventDefault();
      void run("/events/__EVENT__/fields", {
        method: "POST",
        body: JSON.stringify({
          label: draft.label.trim(),
          kind: draft.kind,
          choices: draft.kind === "choice" ? draft.choices.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined
        })
      }).then((ok) => ok && setDraft({ label: "", kind: "text", choices: "" }));
    }

    return (
      <Section title={t("tab.fields")}>
        {data.fields.length === 0 ? <p className="muted">{t("fields.empty")}</p> : null}
        {data.fields.length > 0 ? (
          <form className="admin-form" onSubmit={saveAnswers}>
            {data.fields.map((field) => (
              <div key={field.id} className="extras-field">
                {field.kind === "checkbox" ? (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      disabled={data.ended}
                      checked={answers[field.id] === "yes"}
                      onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.checked ? "yes" : "no" })}
                    />
                    {field.label}
                  </label>
                ) : (
                  <label>
                    {field.label}
                    {field.kind === "choice" ? (
                      <select disabled={data.ended} value={answers[field.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}>
                        <option value="">–</option>
                        {field.choices.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input disabled={data.ended} maxLength={500} value={answers[field.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })} />
                    )}
                  </label>
                )}
                {data.canManage ? (
                  <small className="muted">
                    {t("fields.answers", { count: field.answers?.length ?? 0 })}{" "}
                    <button type="button" className="secondary danger" onClick={() => run(`/fields/${field.id}`, { method: "DELETE" })}>
                      {t("common.remove")}
                    </button>
                  </small>
                ) : null}
              </div>
            ))}
            {!data.ended ? <button type="submit">{t("fields.save")}</button> : null}
          </form>
        ) : null}
        {data.canManage ? (
          <>
            {data.fields.length > 0 ? (
              <p>
                <a href={`/api/m/${host.id}/events/${encodeURIComponent(data.event.id)}/answers.csv`} download>
                  {t("fields.csv")}
                </a>
              </p>
            ) : null}
            <form className="admin-form inline-form" onSubmit={addField}>
              <input required maxLength={120} value={draft.label} placeholder={t("fields.labelPlaceholder")} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {(["text", "checkbox", "choice"] as const).map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`fields.kind.${kind}`)}
                  </option>
                ))}
              </select>
              {draft.kind === "choice" ? (
                <input required value={draft.choices} placeholder={t("fields.choicesPlaceholder")} onChange={(e) => setDraft({ ...draft, choices: e.target.value })} />
              ) : null}
              <button type="submit" disabled={!draft.label.trim()}>
                {t("fields.add")}
              </button>
            </form>
          </>
        ) : null}
      </Section>
    );
  }

  /** Admin › Module › Event-Extras: Kurzüberblick je laufendem Event mit Link zur Modulseite. */
  function Admin(_props: ModuleAdminProps) {
    const [events, setEvents] = useState<EventChoice[] | null>(null);
    const [overviews, setOverviews] = useState<Record<string, Overview>>({});
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      api<{ events: EventChoice[] }>("/events")
        .then((result) => setEvents(result.events.filter((event) => event.status === "running")))
        .catch((caught: Error) => setError(caught.message));
    }, []);

    useEffect(() => {
      if (!events) return;
      events
        .filter((event) => !(event.id in overviews))
        .forEach((event) => {
          api<Overview>(`/events/${encodeURIComponent(event.id)}`)
            .then((data) => setOverviews((previous) => ({ ...previous, [event.id]: data })))
            .catch(() => undefined);
        });
    }, [events]);

    return (
      <section className="extras-admin-overview">
        <p className="muted">{t("admin.intro")}</p>
        {error ? <p className="error">{error}</p> : null}
        {events === null && !error ? <p className="muted">{t("admin.loading")}</p> : null}
        {events && events.length === 0 ? <p className="muted">{t("admin.noRunning")}</p> : null}
        {events && events.length > 0 ? (
          <ul className="device-list">
            {events.map((event) => {
              const overview = overviews[event.id];
              return (
                <li key={event.id} className="device-row">
                  <div>
                    <p>
                      <strong>{event.name}</strong>
                    </p>
                    <small className="muted">
                      {overview
                        ? `${t("admin.summary", {
                            bring: overview.bring.length,
                            install: overview.install.length,
                            lend: overview.lend.length,
                            rides: overview.rides.length,
                            fields: overview.fields.length
                          })} · ${overview.cost ? t("admin.costSet") : t("admin.costNotSet")}`
                        : t("admin.loading")}
                    </small>
                  </div>
                  <div className="device-actions">
                    <a className="button-link secondary" href={`#mitmachen/${host.id}`}>
                      {t("admin.openModule")}
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    );
  }

  function Page(props: ModulePageProps) {
    const initialCostFilter = costFilterFromSubPath(props.subPath);
    const [events, setEvents] = useState<EventChoice[] | null>(null);
    const [eventId, setEventId] = useState("");
    const [data, setData] = useState<Overview | null>(null);
    const [tab, setTab] = useState<Tab>("bring");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      api<{ events: EventChoice[] }>("/events")
        .then((result) => {
          setEvents(result.events);
          const first = result.events.find((event) => event.status !== "ended") ?? result.events[0];
          if (first) setEventId(first.id);
        })
        .catch((caught: Error) => setError(caught.message));
    }, []);

    const load = useCallback(() => {
      if (!eventId) return;
      api<Overview>(`/events/${encodeURIComponent(eventId)}`)
        .then(setData)
        .catch((caught: Error) => setError(caught.message));
    }, [eventId]);

    useEffect(() => {
      setData(null);
      load();
      return host.onRealtime("extras_changed", load);
    }, [load]);

    const run = async (path: string, init?: RequestInit) => {
      setError(null);
      try {
        const next = await api<Overview>(path.replace("__EVENT__", encodeURIComponent(eventId)), init);
        if (next && typeof next === "object" && "event" in next) setData(next);
        else load();
      } catch (caught) {
        setError((caught as Error).message);
        throw caught;
      }
    };
    const safeRun: Run = (path, init) =>
      run(path, init).then(
        () => true,
        () => false
      );

    if (events && events.length === 0) return <p className="muted">{t("page.noEvents")}</p>;
    return (
      <section className="extras-page">
        {events ? (
          <label>
            {t("page.event")}
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                  {event.status === "ended" ? ` (${t("page.ended")})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        {data?.ended ? <p className="muted">{t("page.readOnly")}</p> : null}
        {/* Kern-Baustein .tab-strip (AP0): eine Zeile, rollt auf dem Handy waagerecht statt umzubrechen. */}
        <nav className="tab-strip" role="tablist">
          {TABS.map((entry) => (
            <button key={entry} type="button" role="tab" aria-selected={tab === entry} className={tab === entry ? "tab-strip__tab active" : "tab-strip__tab"} onClick={() => setTab(entry)}>
              {t(`tab.${entry}`)}
            </button>
          ))}
        </nav>
        {!data ? <p className="muted">…</p> : null}
        {data && tab === "bring" ? <BringTab data={data} run={safeRun} /> : null}
        {data && tab === "install" ? <InstallTab data={data} run={safeRun} /> : null}
        {data && tab === "lend" ? <LendTab data={data} run={safeRun} /> : null}
        {data && tab === "cost" ? <CostTab key={data.event.id} data={data} run={safeRun} initialFilter={initialCostFilter} /> : null}
        {data && tab === "rides" ? <RidesTab data={data} run={safeRun} /> : null}
        {data && tab === "fields" ? <FieldsTab data={data} run={safeRun} /> : null}
      </section>
    );
  }

  return { Page, Admin };
}
