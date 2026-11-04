import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import type { ModuleContext, ModuleUser } from "@matchdesk/module-sdk";
import { createAccess, type EventRow } from "./access";

/*
 * Event-Extras: alles hängt an einem Event (main_events).
 * - Listen: install (Downloads/Installation, abhaken), bring (Mitbringen, „ich bringe mit“), lend (Verleih)
 * - Unkostenbeitrag pro Person mit Meldung „bezahlt“ (bar/PayPal) und Bestätigung durch Verwalter
 * - Fahrgemeinschaften mit Plätzen
 * - Zusatzfragen mit Antworten und CSV für Verwalter
 * Nach dem Eventende ist alles nur noch lesbar, außer „zurückgegeben“ und Zahlungen.
 */

type ListKind = "install" | "bring" | "lend";
type ItemRow = {
  id: string;
  main_event_id: string;
  list: ListKind;
  title: string;
  details: string | null;
  url: string | null;
  quantity: number | null;
  owner_user_id: string | null;
  borrowed_by_user_id: string | null;
  borrowed_at: string | null;
  returned_at: string | null;
  position: number;
  created_by: string | null;
  created_at: string;
};
type RideRow = {
  id: string;
  main_event_id: string;
  driver_user_id: string;
  direction: "there" | "back" | "both";
  start_place: string;
  departs_at: string | null;
  seats: number;
  note: string | null;
};
type FieldRow = { id: string; main_event_id: string; label: string; kind: "text" | "checkbox" | "choice"; choices: string | null; position: number };
type UserRow = { id: string; username: string; display_name: string | null };

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "nur_http");
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDate = z.string().datetime({ offset: true }).nullable().optional();

const itemInput = z.object({
  list: z.enum(["install", "bring", "lend"]),
  title: z.string().trim().min(1).max(120),
  details: optionalText(1000),
  url: httpUrl.nullable().optional(),
  quantity: z.number().int().min(1).max(999).nullable().optional()
});
const itemUpdate = itemInput.omit({ list: true }).partial();
const costInput = z.object({
  amountCents: z.number().int().min(0).max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("EUR"),
  note: optionalText(500),
  paypalUrl: httpUrl.nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
});
const rideInput = z.object({
  direction: z.enum(["there", "back", "both"]),
  startPlace: z.string().trim().min(1).max(120),
  departsAt: isoDate,
  seats: z.number().int().min(1).max(8),
  note: optionalText(500)
});
const fieldInput = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["text", "checkbox", "choice"]),
  choices: z.array(z.string().trim().min(1).max(60)).max(20).optional()
});

const now = () => new Date().toISOString();
const utc = (value: string | null | undefined) => (value ? new Date(value).toISOString() : null);

export function register(ctx: ModuleContext) {
  const access = createAccess(ctx);
  const fail = (response: Response, status: number, error: string) => void response.status(status).json({ error });
  const changed = () => ctx.realtime.broadcast("extras_changed");

  const users = (ids: Iterable<string | null>) => {
    const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map<string, UserRow>();
    const rows = ctx.db
      .prepare(`SELECT id, username, display_name FROM users WHERE id IN (${unique.map(() => "?").join(",")})`)
      .all(...unique) as UserRow[];
    return new Map(rows.map((row) => [row.id, row]));
  };
  const person = (map: Map<string, UserRow>, id: string | null) => {
    const row = id ? map.get(id) : undefined;
    return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
  };

  function itemOf(id: string) {
    return ctx.db.prepare("SELECT * FROM extras_items WHERE id = ?").get(id) as ItemRow | undefined;
  }

  /** Eintrag laden und wie bei /events/:id prüfen. */
  function enterItem(request: Request, response: Response, write = false) {
    const item = itemOf(String(request.params.itemId));
    if (!item) {
      fail(response, 404, "eintrag_nicht_gefunden");
      return null;
    }
    const entered = access.enter(request, response, item.main_event_id, { write });
    return entered ? { ...entered, item } : null;
  }

  // ---------- Übersicht ----------

  ctx.router.get("/events", (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return fail(response, 401, "nicht_angemeldet");
    if (!ctx.can(user, "extras.view")) return fail(response, 403, "recht_fehlt");
    response.json({
      events: access.visibleEvents(user).map((event) => ({
        id: event.id,
        name: event.name,
        status: event.status,
        canManage: access.canManage(user, event.id)
      }))
    });
  });

  function overview(user: ModuleUser, event: EventRow, manage: boolean) {
    const items = ctx.db.prepare("SELECT * FROM extras_items WHERE main_event_id = ? ORDER BY list, position, created_at").all(event.id) as ItemRow[];
    const claims = ctx.db
      .prepare("SELECT c.item_id, c.user_id, c.quantity FROM extras_bring_claims c JOIN extras_items i ON i.id = c.item_id WHERE i.main_event_id = ?")
      .all(event.id) as Array<{ item_id: string; user_id: string; quantity: number }>;
    const done = ctx.db
      .prepare("SELECT d.item_id, d.user_id FROM extras_install_done d JOIN extras_items i ON i.id = d.item_id WHERE i.main_event_id = ?")
      .all(event.id) as Array<{ item_id: string; user_id: string }>;
    const rides = ctx.db.prepare("SELECT * FROM extras_rides WHERE main_event_id = ? ORDER BY direction, departs_at, created_at").all(event.id) as RideRow[];
    const seats = ctx.db
      .prepare("SELECT s.ride_id, s.user_id FROM extras_ride_seats s JOIN extras_rides r ON r.id = s.ride_id WHERE r.main_event_id = ? ORDER BY s.created_at")
      .all(event.id) as Array<{ ride_id: string; user_id: string }>;
    const fields = ctx.db.prepare("SELECT * FROM extras_fields WHERE main_event_id = ? ORDER BY position, created_at").all(event.id) as FieldRow[];
    const answers = ctx.db
      .prepare("SELECT a.field_id, a.user_id, a.value FROM extras_field_answers a JOIN extras_fields f ON f.id = a.field_id WHERE f.main_event_id = ?")
      .all(event.id) as Array<{ field_id: string; user_id: string; value: string }>;
    const cost = ctx.db.prepare("SELECT * FROM extras_costs WHERE main_event_id = ?").get(event.id) as
      | { amount_cents: number; currency: string; note: string | null; paypal_url: string | null; due_date: string | null }
      | undefined;
    const payments = ctx.db.prepare("SELECT * FROM extras_payments WHERE main_event_id = ?").all(event.id) as Array<{
      user_id: string;
      method: string;
      status: string;
      reported_at: string | null;
      confirmed_at: string | null;
    }>;
    const joined = access.joinedUserIds(event.id);
    const people = users([
      ...items.flatMap((item) => [item.owner_user_id, item.borrowed_by_user_id, item.created_by]),
      ...claims.map((claim) => claim.user_id),
      ...rides.map((ride) => ride.driver_user_id),
      ...seats.map((seat) => seat.user_id),
      ...answers.map((answer) => answer.user_id),
      ...payments.map((payment) => payment.user_id),
      ...(joined ?? [])
    ]);

    const serializeItem = (item: ItemRow) => {
      const base = { id: item.id, list: item.list, title: item.title, details: item.details, url: item.url };
      if (item.list === "install") {
        const doneBy = done.filter((entry) => entry.item_id === item.id);
        return { ...base, doneCount: doneBy.length, doneByMe: doneBy.some((entry) => entry.user_id === user.id) };
      }
      if (item.list === "bring") {
        const forItem = claims.filter((claim) => claim.item_id === item.id);
        return {
          ...base,
          quantity: item.quantity,
          brought: forItem.reduce((sum, claim) => sum + claim.quantity, 0),
          mine: forItem.find((claim) => claim.user_id === user.id)?.quantity ?? 0,
          canEdit: manage || item.created_by === user.id,
          claims: forItem.map((claim) => ({ user: person(people, claim.user_id), quantity: claim.quantity }))
        };
      }
      const out = Boolean(item.borrowed_by_user_id && !item.returned_at);
      return {
        ...base,
        owner: person(people, item.owner_user_id),
        borrowedBy: person(people, item.borrowed_by_user_id),
        borrowedAt: item.borrowed_at,
        returnedAt: item.returned_at,
        out,
        canEdit: manage || item.owner_user_id === user.id,
        canReturn: out && (manage || item.owner_user_id === user.id || item.borrowed_by_user_id === user.id)
      };
    };

    const mine = (payment?: { method: string; status: string; reported_at: string | null; confirmed_at: string | null }) =>
      payment ? { method: payment.method, status: payment.status, reportedAt: payment.reported_at, confirmedAt: payment.confirmed_at } : null;

    // Für Verwalter: alle Zugesagten plus alle, die schon etwas gemeldet haben.
    const owing = manage && cost ? [...new Set([...(joined ?? []), ...payments.map((payment) => payment.user_id)])] : [];

    return {
      event: { id: event.id, name: event.name, status: event.status },
      canManage: manage,
      ended: event.status === "ended",
      me: { id: user.id },
      install: items.filter((item) => item.list === "install").map(serializeItem),
      bring: items.filter((item) => item.list === "bring").map(serializeItem),
      lend: items.filter((item) => item.list === "lend").map(serializeItem),
      cost: cost
        ? {
            amountCents: cost.amount_cents,
            currency: cost.currency,
            note: cost.note,
            paypalUrl: cost.paypal_url,
            dueDate: cost.due_date,
            mine: mine(payments.find((payment) => payment.user_id === user.id)),
            payments: manage
              ? owing
                  .map((userId) => ({ user: person(people, userId), payment: mine(payments.find((payment) => payment.user_id === userId)) }))
                  .filter((entry) => entry.user)
              : undefined
          }
        : null,
      rides: rides.map((ride) => {
        const taken = seats.filter((seat) => seat.ride_id === ride.id);
        return {
          id: ride.id,
          direction: ride.direction,
          startPlace: ride.start_place,
          departsAt: ride.departs_at,
          seats: ride.seats,
          free: Math.max(0, ride.seats - taken.length),
          note: ride.note,
          driver: person(people, ride.driver_user_id),
          passengers: taken.map((seat) => person(people, seat.user_id)),
          joined: taken.some((seat) => seat.user_id === user.id),
          canEdit: manage || ride.driver_user_id === user.id
        };
      }),
      fields: fields.map((field) => ({
        id: field.id,
        label: field.label,
        kind: field.kind,
        choices: field.choices ? (JSON.parse(field.choices) as string[]) : [],
        mine: answers.find((answer) => answer.field_id === field.id && answer.user_id === user.id)?.value ?? null,
        answers: manage
          ? answers.filter((answer) => answer.field_id === field.id).map((answer) => ({ user: person(people, answer.user_id), value: answer.value }))
          : undefined
      }))
    };
  }

  ctx.router.get("/events/:eventId", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId));
    if (entered) response.json(overview(entered.user, entered.event, entered.manage));
  });

  const reply = (response: Response, entered: { user: ModuleUser; event: EventRow; manage: boolean }, status = 200) => {
    changed();
    response.status(status).json(overview(entered.user, entered.event, entered.manage));
  };

  // ---------- Listen ----------

  ctx.router.post("/events/:eventId/items", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (entered.ended) return fail(response, 409, "event_beendet");
    const parsed = itemInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "eintrag_ungueltig");
    const input = parsed.data;
    // Installationsliste pflegen nur Verwalter; mitbringen und verleihen darf jeder Teilnehmer.
    if (input.list === "install" && !entered.manage) return fail(response, 403, "recht_fehlt");
    const position = (
      ctx.db.prepare("SELECT COUNT(*) AS count FROM extras_items WHERE main_event_id = ? AND list = ?").get(entered.event.id, input.list) as {
        count: number;
      }
    ).count;
    const id = randomUUID();
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO extras_items (id, main_event_id, list, title, details, url, quantity, owner_user_id, position, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          entered.event.id,
          input.list,
          input.title,
          input.details || null,
          input.list === "install" ? (input.url ?? null) : null,
          input.list === "bring" ? (input.quantity ?? null) : null,
          input.list === "lend" ? entered.user.id : null,
          position,
          entered.user.id,
          now()
        );
      // Wer selbst etwas auf die Mitbringliste setzt (ohne Verwalter zu sein), bringt es auch mit.
      if (input.list === "bring" && !entered.manage) {
        ctx.db
          .prepare("INSERT INTO extras_bring_claims (item_id, user_id, quantity, created_at) VALUES (?, ?, ?, ?)")
          .run(id, entered.user.id, input.quantity ?? 1, now());
      }
    })();
    reply(response, entered, 201);
  });

  ctx.router.patch("/items/:itemId", (request, response) => {
    const entered = enterItem(request, response, true);
    if (!entered) return;
    const { item } = entered;
    if (entered.ended) return fail(response, 409, "event_beendet");
    const own = item.list === "lend" ? item.owner_user_id === entered.user.id : item.list === "bring" && item.created_by === entered.user.id;
    if (!entered.manage && !own) return fail(response, 403, "recht_fehlt");
    const parsed = itemUpdate.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "eintrag_ungueltig");
    const input = parsed.data;
    ctx.db
      .prepare("UPDATE extras_items SET title = ?, details = ?, url = ?, quantity = ? WHERE id = ?")
      .run(
        input.title ?? item.title,
        input.details === undefined ? item.details : input.details || null,
        item.list === "install" && input.url !== undefined ? input.url : item.url,
        item.list === "bring" && input.quantity !== undefined ? input.quantity : item.quantity,
        item.id
      );
    reply(response, entered);
  });

  ctx.router.delete("/items/:itemId", (request, response) => {
    const entered = enterItem(request, response, true);
    if (!entered) return;
    const { item } = entered;
    const own = item.list === "lend" ? item.owner_user_id === entered.user.id : item.list === "bring" && item.created_by === entered.user.id;
    if (!entered.manage && !own) return fail(response, 403, "recht_fehlt");
    if (item.list === "lend" && item.borrowed_by_user_id && !item.returned_at) return fail(response, 409, "noch_ausgeliehen");
    ctx.db.prepare("DELETE FROM extras_items WHERE id = ?").run(item.id);
    reply(response, entered);
  });

  /** Mitbringliste: eigene Menge setzen, 0 = nicht mehr mitbringen. */
  ctx.router.put("/items/:itemId/bring", (request, response) => {
    const entered = enterItem(request, response, true);
    if (!entered) return;
    if (entered.item.list !== "bring") return fail(response, 400, "falsche_liste");
    if (entered.ended) return fail(response, 409, "event_beendet");
    const parsed = z.object({ quantity: z.number().int().min(0).max(999) }).safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "menge_ungueltig");
    if (parsed.data.quantity === 0) {
      ctx.db.prepare("DELETE FROM extras_bring_claims WHERE item_id = ? AND user_id = ?").run(entered.item.id, entered.user.id);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO extras_bring_claims (item_id, user_id, quantity, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (item_id, user_id) DO UPDATE SET quantity = excluded.quantity`
        )
        .run(entered.item.id, entered.user.id, parsed.data.quantity, now());
    }
    reply(response, entered);
  });

  /** Installationsliste: für sich abhaken. */
  ctx.router.put("/items/:itemId/done", (request, response) => {
    const entered = enterItem(request, response, true);
    if (!entered) return;
    if (entered.item.list !== "install") return fail(response, 400, "falsche_liste");
    const parsed = z.object({ done: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "wert_ungueltig");
    if (parsed.data.done) {
      ctx.db
        .prepare("INSERT OR IGNORE INTO extras_install_done (item_id, user_id, done_at) VALUES (?, ?, ?)")
        .run(entered.item.id, entered.user.id, now());
    } else {
      ctx.db.prepare("DELETE FROM extras_install_done WHERE item_id = ? AND user_id = ?").run(entered.item.id, entered.user.id);
    }
    reply(response, entered);
  });

  /** Verleihliste: selbst ausleihen, oder als Besitzer/Verwalter an jemanden verleihen. */
  ctx.router.post("/items/:itemId/borrow", (request, response) => {
    const entered = enterItem(request, response, true);
    if (!entered) return;
    const { item } = entered;
    if (item.list !== "lend") return fail(response, 400, "falsche_liste");
    if (entered.ended) return fail(response, 409, "event_beendet");
    if (item.borrowed_by_user_id && !item.returned_at) return fail(response, 409, "schon_ausgeliehen");
    const parsed = z.object({ userId: z.string().min(1).max(64).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return fail(response, 400, "wert_ungueltig");
    let borrower = entered.user.id;
    if (parsed.data.userId && parsed.data.userId !== entered.user.id) {
      if (!entered.manage && item.owner_user_id !== entered.user.id) return fail(response, 403, "recht_fehlt");
      const target = ctx.db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(parsed.data.userId) as { id: string } | undefined;
      if (!target) return fail(response, 400, "benutzer_nicht_gefunden");
      borrower = target.id;
    }
    if (borrower === item.owner_user_id) return fail(response, 400, "eigener_gegenstand");
    ctx.db.prepare("UPDATE extras_items SET borrowed_by_user_id = ?, borrowed_at = ?, returned_at = NULL WHERE id = ?").run(borrower, now(), item.id);
    ctx.audit({ actor: entered.user, action: "lend_borrowed", summary: `„${item.title}“ ausgeliehen`, entityId: item.id, metadata: { borrower } });
    reply(response, entered);
  });

  /** Zurückgegeben: Besitzer, Ausleiher oder Verwalter, auch nach dem Eventende. */
  ctx.router.post("/items/:itemId/return", (request, response) => {
    const entered = enterItem(request, response, true);
    if (!entered) return;
    const { item } = entered;
    if (item.list !== "lend") return fail(response, 400, "falsche_liste");
    if (!item.borrowed_by_user_id || item.returned_at) return fail(response, 409, "nicht_ausgeliehen");
    if (!entered.manage && item.owner_user_id !== entered.user.id && item.borrowed_by_user_id !== entered.user.id) {
      return fail(response, 403, "recht_fehlt");
    }
    ctx.db.prepare("UPDATE extras_items SET returned_at = ? WHERE id = ?").run(now(), item.id);
    ctx.audit({ actor: entered.user, action: "lend_returned", summary: `„${item.title}“ zurückgegeben`, entityId: item.id });
    reply(response, entered);
  });

  // ---------- Unkostenbeitrag ----------

  ctx.router.put("/events/:eventId/cost", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (!entered.manage) return fail(response, 403, "recht_fehlt");
    const parsed = costInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "beitrag_ungueltig");
    const input = parsed.data;
    ctx.db
      .prepare(
        `INSERT INTO extras_costs (main_event_id, amount_cents, currency, note, paypal_url, due_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (main_event_id) DO UPDATE SET amount_cents = excluded.amount_cents, currency = excluded.currency, note = excluded.note,
           paypal_url = excluded.paypal_url, due_date = excluded.due_date, updated_at = excluded.updated_at`
      )
      .run(entered.event.id, input.amountCents, input.currency, input.note || null, input.paypalUrl ?? null, input.dueDate ?? null, now());
    ctx.audit({
      actor: entered.user,
      action: "cost_set",
      summary: `Unkostenbeitrag für ${entered.event.name} auf ${(input.amountCents / 100).toFixed(2)} ${input.currency} gesetzt`,
      entityId: entered.event.id
    });
    reply(response, entered);
  });

  ctx.router.delete("/events/:eventId/cost", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (!entered.manage) return fail(response, 403, "recht_fehlt");
    ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM extras_costs WHERE main_event_id = ?").run(entered.event.id);
      ctx.db.prepare("DELETE FROM extras_payments WHERE main_event_id = ?").run(entered.event.id);
    })();
    reply(response, entered);
  });

  /** Eigene Zahlung melden („bezahlt per bar/PayPal“) oder zurückziehen, solange nicht bestätigt. */
  ctx.router.put("/events/:eventId/payment", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (!ctx.db.prepare("SELECT 1 FROM extras_costs WHERE main_event_id = ?").get(entered.event.id)) return fail(response, 409, "kein_beitrag");
    const parsed = z.object({ method: z.enum(["cash", "paypal"]).nullable() }).safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "zahlung_ungueltig");
    const existing = ctx.db.prepare("SELECT status FROM extras_payments WHERE main_event_id = ? AND user_id = ?").get(entered.event.id, entered.user.id) as
      | { status: string }
      | undefined;
    if (existing?.status === "confirmed") return fail(response, 409, "zahlung_bestaetigt");
    if (parsed.data.method === null) {
      ctx.db.prepare("DELETE FROM extras_payments WHERE main_event_id = ? AND user_id = ?").run(entered.event.id, entered.user.id);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO extras_payments (main_event_id, user_id, method, status, reported_at) VALUES (?, ?, ?, 'reported', ?)
           ON CONFLICT (main_event_id, user_id) DO UPDATE SET method = excluded.method, status = 'reported', reported_at = excluded.reported_at`
        )
        .run(entered.event.id, entered.user.id, parsed.data.method, now());
    }
    reply(response, entered);
  });

  /** Verwalter: Zahlung bestätigen (auch ohne Meldung, z. B. bar vor Ort) oder wieder auf offen setzen. */
  ctx.router.put("/events/:eventId/payments/:userId", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (!entered.manage) return fail(response, 403, "recht_fehlt");
    if (!ctx.db.prepare("SELECT 1 FROM extras_costs WHERE main_event_id = ?").get(entered.event.id)) return fail(response, 409, "kein_beitrag");
    const parsed = z.object({ status: z.enum(["open", "confirmed"]), method: z.enum(["cash", "paypal"]).optional() }).safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "zahlung_ungueltig");
    const target = ctx.db.prepare("SELECT id, username FROM users WHERE id = ?").get(String(request.params.userId)) as
      | { id: string; username: string }
      | undefined;
    if (!target) return fail(response, 404, "benutzer_nicht_gefunden");
    if (parsed.data.status === "open") {
      ctx.db.prepare("DELETE FROM extras_payments WHERE main_event_id = ? AND user_id = ?").run(entered.event.id, target.id);
    } else {
      const existing = ctx.db.prepare("SELECT method FROM extras_payments WHERE main_event_id = ? AND user_id = ?").get(entered.event.id, target.id) as
        | { method: string }
        | undefined;
      ctx.db
        .prepare(
          `INSERT INTO extras_payments (main_event_id, user_id, method, status, confirmed_by, confirmed_at) VALUES (?, ?, ?, 'confirmed', ?, ?)
           ON CONFLICT (main_event_id, user_id) DO UPDATE SET method = excluded.method, status = 'confirmed',
             confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`
        )
        .run(entered.event.id, target.id, parsed.data.method ?? existing?.method ?? "cash", entered.user.id, now());
    }
    ctx.audit({
      actor: entered.user,
      action: parsed.data.status === "confirmed" ? "payment_confirmed" : "payment_reset",
      summary: `Unkostenbeitrag von ${target.username} ${parsed.data.status === "confirmed" ? "bestätigt" : "auf offen gesetzt"}`,
      entityId: entered.event.id,
      metadata: { userId: target.id }
    });
    reply(response, entered);
  });

  // ---------- Fahrgemeinschaften ----------

  function enterRide(request: Request, response: Response) {
    const ride = ctx.db.prepare("SELECT * FROM extras_rides WHERE id = ?").get(String(request.params.rideId)) as RideRow | undefined;
    if (!ride) {
      fail(response, 404, "fahrt_nicht_gefunden");
      return null;
    }
    const entered = access.enter(request, response, ride.main_event_id, { write: true });
    return entered ? { ...entered, ride } : null;
  }

  ctx.router.post("/events/:eventId/rides", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (entered.ended) return fail(response, 409, "event_beendet");
    const parsed = rideInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "fahrt_ungueltig");
    const input = parsed.data;
    ctx.db
      .prepare(
        "INSERT INTO extras_rides (id, main_event_id, driver_user_id, direction, start_place, departs_at, seats, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), entered.event.id, entered.user.id, input.direction, input.startPlace, utc(input.departsAt), input.seats, input.note || null, now());
    reply(response, entered, 201);
  });

  ctx.router.patch("/rides/:rideId", (request, response) => {
    const entered = enterRide(request, response);
    if (!entered) return;
    const { ride } = entered;
    if (!entered.manage && ride.driver_user_id !== entered.user.id) return fail(response, 403, "recht_fehlt");
    if (entered.ended) return fail(response, 409, "event_beendet");
    const parsed = rideInput.partial().safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "fahrt_ungueltig");
    const input = parsed.data;
    const taken = (ctx.db.prepare("SELECT COUNT(*) AS count FROM extras_ride_seats WHERE ride_id = ?").get(ride.id) as { count: number }).count;
    if (input.seats !== undefined && input.seats < taken) return fail(response, 409, "plaetze_belegt");
    ctx.db
      .prepare("UPDATE extras_rides SET direction = ?, start_place = ?, departs_at = ?, seats = ?, note = ? WHERE id = ?")
      .run(
        input.direction ?? ride.direction,
        input.startPlace ?? ride.start_place,
        input.departsAt === undefined ? ride.departs_at : utc(input.departsAt),
        input.seats ?? ride.seats,
        input.note === undefined ? ride.note : input.note || null,
        ride.id
      );
    reply(response, entered);
  });

  ctx.router.delete("/rides/:rideId", (request, response) => {
    const entered = enterRide(request, response);
    if (!entered) return;
    if (!entered.manage && entered.ride.driver_user_id !== entered.user.id) return fail(response, 403, "recht_fehlt");
    ctx.db.prepare("DELETE FROM extras_rides WHERE id = ?").run(entered.ride.id);
    reply(response, entered);
  });

  ctx.router.put("/rides/:rideId/seat", (request, response) => {
    const entered = enterRide(request, response);
    if (!entered) return;
    const { ride } = entered;
    if (entered.ended) return fail(response, 409, "event_beendet");
    if (ride.driver_user_id === entered.user.id) return fail(response, 400, "eigene_fahrt");
    const result = ctx.db.transaction(() => {
      if (ctx.db.prepare("SELECT 1 FROM extras_ride_seats WHERE ride_id = ? AND user_id = ?").get(ride.id, entered.user.id)) return "ok";
      const taken = (ctx.db.prepare("SELECT COUNT(*) AS count FROM extras_ride_seats WHERE ride_id = ?").get(ride.id) as { count: number }).count;
      if (taken >= ride.seats) return "voll";
      ctx.db.prepare("INSERT INTO extras_ride_seats (ride_id, user_id, created_at) VALUES (?, ?, ?)").run(ride.id, entered.user.id, now());
      return "ok";
    })();
    if (result === "voll") return fail(response, 409, "fahrt_voll");
    reply(response, entered);
  });

  ctx.router.delete("/rides/:rideId/seat", (request, response) => {
    const entered = enterRide(request, response);
    if (!entered) return;
    ctx.db.prepare("DELETE FROM extras_ride_seats WHERE ride_id = ? AND user_id = ?").run(entered.ride.id, entered.user.id);
    reply(response, entered);
  });

  // ---------- Zusatzfragen ----------

  ctx.router.post("/events/:eventId/fields", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (!entered.manage) return fail(response, 403, "recht_fehlt");
    const parsed = fieldInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "frage_ungueltig");
    const input = parsed.data;
    if (input.kind === "choice" && (input.choices ?? []).length < 2) return fail(response, 400, "zu_wenige_antworten");
    const position = (ctx.db.prepare("SELECT COUNT(*) AS count FROM extras_fields WHERE main_event_id = ?").get(entered.event.id) as { count: number })
      .count;
    ctx.db
      .prepare("INSERT INTO extras_fields (id, main_event_id, label, kind, choices, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), entered.event.id, input.label, input.kind, input.kind === "choice" ? JSON.stringify(input.choices) : null, position, now());
    reply(response, entered, 201);
  });

  ctx.router.delete("/fields/:fieldId", (request, response) => {
    const field = ctx.db.prepare("SELECT * FROM extras_fields WHERE id = ?").get(String(request.params.fieldId)) as FieldRow | undefined;
    if (!field) return fail(response, 404, "frage_nicht_gefunden");
    const entered = access.enter(request, response, field.main_event_id, { write: true });
    if (!entered) return;
    if (!entered.manage) return fail(response, 403, "recht_fehlt");
    ctx.db.prepare("DELETE FROM extras_fields WHERE id = ?").run(field.id);
    reply(response, entered);
  });

  /** Eigene Antworten setzen; leerer Wert löscht die Antwort. */
  ctx.router.put("/events/:eventId/answers", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId), { write: true });
    if (!entered) return;
    if (entered.ended) return fail(response, 409, "event_beendet");
    const parsed = z.object({ answers: z.record(z.string().max(64), z.string().max(500)) }).safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "antwort_ungueltig");
    const fields = new Map(
      (ctx.db.prepare("SELECT * FROM extras_fields WHERE main_event_id = ?").all(entered.event.id) as FieldRow[]).map((field) => [field.id, field])
    );
    for (const [fieldId, value] of Object.entries(parsed.data.answers)) {
      const field = fields.get(fieldId);
      if (!field) return fail(response, 400, "frage_nicht_gefunden");
      if (!value) continue;
      if (field.kind === "checkbox" && value !== "yes" && value !== "no") return fail(response, 400, "antwort_ungueltig");
      if (field.kind === "choice" && !(JSON.parse(field.choices ?? "[]") as string[]).includes(value)) return fail(response, 400, "antwort_ungueltig");
    }
    ctx.db.transaction(() => {
      for (const [fieldId, raw] of Object.entries(parsed.data.answers)) {
        const value = raw.trim();
        if (!value) {
          ctx.db.prepare("DELETE FROM extras_field_answers WHERE field_id = ? AND user_id = ?").run(fieldId, entered.user.id);
        } else {
          ctx.db
            .prepare(
              `INSERT INTO extras_field_answers (field_id, user_id, value, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (field_id, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            )
            .run(fieldId, entered.user.id, value, now());
        }
      }
    })();
    reply(response, entered);
  });

  /** CSV mit allen Antworten und Mitbring-/Fahrt-Angaben für Verwalter. */
  ctx.router.get("/events/:eventId/answers.csv", (request, response) => {
    const entered = access.enter(request, response, String(request.params.eventId));
    if (!entered) return;
    if (!entered.manage) return fail(response, 403, "recht_fehlt");
    const fields = ctx.db.prepare("SELECT * FROM extras_fields WHERE main_event_id = ? ORDER BY position, created_at").all(entered.event.id) as FieldRow[];
    const rows = ctx.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, a.field_id, a.value
         FROM extras_field_answers a JOIN extras_fields f ON f.id = a.field_id JOIN users u ON u.id = a.user_id
         WHERE f.main_event_id = ? ORDER BY u.username`
      )
      .all(entered.event.id) as Array<{ id: string; username: string; display_name: string | null; field_id: string; value: string }>;
    const byUser = new Map<string, { username: string; displayName: string | null; values: Map<string, string> }>();
    for (const row of rows) {
      const entry = byUser.get(row.id) ?? { username: row.username, displayName: row.display_name, values: new Map() };
      entry.values.set(row.field_id, row.value);
      byUser.set(row.id, entry);
    }
    // Formeln in Tabellenprogrammen entschärfen (=, +, -, @ am Anfang).
    const cell = (value: string) => {
      const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [
      ["Benutzer", "Anzeigename", ...fields.map((field) => field.label)].map(cell).join(";"),
      ...[...byUser.values()].map((entry) =>
        [entry.username, entry.displayName ?? "", ...fields.map((field) => entry.values.get(field.id) ?? "")].map(cell).join(";")
      )
    ];
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="zusatzfragen-${entered.event.id}.csv"`);
    response.send(`﻿${lines.join("\r\n")}\r\n`);
  });

  ctx.log.info("Modul Event-Extras gestartet");
}
