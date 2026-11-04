import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseContext } from "../../db/client";
import { pizzaOrderLineExtras, pizzaOrderLines, pizzaOrders, pizzaSessions } from "../../db/schema";
import { getExtraById, PIZZA_MAX_EXTRAS_PER_LINE, resolveExtraPriceCents } from "./extras";
import { AppError } from "../../http/errors";
import { canMarkPayment, canPlaceOrder } from "./lifecycle";
import { getVariantWithItem } from "./menu";
import type { PizzaPaymentMethod } from "./payment";
import {
  assertCanAddLine,
  assertValidNote,
  assertValidQty,
  normalizeNote,
  PizzaOrderLimitError
} from "./order-limits";

function nowIso() {
  return new Date().toISOString();
}

export class PizzaOrderError extends AppError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status);
  }
}

/** Archivierte Runden sind eingefroren: keine Positionen, keine Bezahlart, kein Zahlstatus (René, PR #14). */
function assertNotArchived(session: { archivedAt: string | null }) {
  if (session.archivedAt) {
    throw new PizzaOrderError("pizza_runde_archiviert", "Bestellrunde ist archiviert", 409);
  }
}

/** Offen und nicht archiviert: Eine archivierte Runde bleibt unverändert, auch wenn sie im Zustand `open` archiviert wurde. */
function assertSessionOpen(session: { state: string; archivedAt: string | null }) {
  assertNotArchived(session);
  if (!canPlaceOrder(session.state as never)) {
    throw new PizzaOrderError("session_not_open", "Bestellung ist nicht offen");
  }
}

function getOrCreateOrder(
  context: DatabaseContext,
  sessionId: string,
  userId: string,
  paymentMethod: PizzaPaymentMethod | null
) {
  const existing = context.db
    .select()
    .from(pizzaOrders)
    .where(and(eq(pizzaOrders.sessionId, sessionId), eq(pizzaOrders.userId, userId)))
    .get();
  if (existing) return existing;

  const now = nowIso();
  const id = randomUUID();
  context.db
    .insert(pizzaOrders)
    .values({
      id,
      sessionId,
      userId,
      paymentStatus: "unpaid",
      paymentMethod,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return context.db.select().from(pizzaOrders).where(eq(pizzaOrders.id, id)).get()!;
}

function getSession(context: DatabaseContext, sessionId: string) {
  const session = context.db
    .select()
    .from(pizzaSessions)
    .where(eq(pizzaSessions.id, sessionId))
    .get();
  if (!session) throw new PizzaOrderError("session_missing", "Bestell-Session nicht gefunden", 404);
  return session;
}

export interface PizzaLineExtra {
  extraId: string;
  name: string;
  priceCentsSnapshot: number;
}

function listLinesForOrder(context: DatabaseContext, orderId: string) {
  const lines = context.db
    .select()
    .from(pizzaOrderLines)
    .where(eq(pizzaOrderLines.orderId, orderId))
    .orderBy(asc(pizzaOrderLines.createdAt))
    .all();
  const extras = context.sqlite
    .prepare(
      `SELECT e.line_id AS lineId, e.extra_id AS extraId, e.name_snapshot AS name, e.price_cents_snapshot AS priceCentsSnapshot
       FROM pizza_order_line_extras e
       JOIN pizza_order_lines l ON l.id = e.line_id
       WHERE l.order_id = ?
       ORDER BY e.rowid`
    )
    .all(orderId) as Array<PizzaLineExtra & { lineId: string }>;
  const byLine = new Map<string, PizzaLineExtra[]>();
  for (const { lineId, ...extra } of extras) {
    const list = byLine.get(lineId) ?? [];
    list.push(extra);
    byLine.set(lineId, list);
  }
  return lines.map((line) => ({ ...line, extras: byLine.get(line.id) ?? [] }));
}

function assertExtraIdsShape(extraIds: string[]) {
  if (extraIds.length > PIZZA_MAX_EXTRAS_PER_LINE) {
    throw new PizzaOrderError("pizza_zu_viele_extras", `Höchstens ${PIZZA_MAX_EXTRAS_PER_LINE} Extras pro Position`);
  }
  if (new Set(extraIds).size !== extraIds.length) {
    throw new PizzaOrderError("pizza_extra_doppelt", "Jedes Extra höchstens einmal pro Position");
  }
}

/**
 * Prüft neu gewählte Extras: aktiv und für die Kategorie des Artikels angeboten. Bereits an der
 * Position hängende Extras (`keep`) bleiben auch erhalten, wenn sie inzwischen deaktiviert sind.
 */
function resolveNewExtras(
  context: DatabaseContext,
  extraIds: string[],
  categoryId: string,
  variantId: string,
  keep: Set<string> = new Set()
) {
  return extraIds
    .filter((id) => !keep.has(id))
    .map((id) => {
      const extra = getExtraById(context, id);
      if (!extra || !extra.active || !extra.categoryIds.includes(categoryId)) {
        throw new PizzaOrderError("pizza_extra_nicht_verfuegbar", "Extra ist für diesen Artikel nicht verfügbar");
      }
      return { id: extra.id, name: extra.name, priceCents: resolveExtraPriceCents(extra, variantId) };
    });
}

function insertLineExtras(
  context: DatabaseContext,
  lineId: string,
  extras: Array<{ id: string; name: string; priceCents: number }>
) {
  const now = nowIso();
  for (const extra of extras) {
    context.db
      .insert(pizzaOrderLineExtras)
      .values({ lineId, extraId: extra.id, nameSnapshot: extra.name, priceCentsSnapshot: extra.priceCents, createdAt: now })
      .run();
  }
}

export interface AddLineInput {
  sessionId: string;
  userId: string;
  variantId: string;
  qty: number;
  customNote?: string | null;
  /** Gewählte Extras (jedes höchstens einmal, nur der Kategorie des Artikels). */
  extraIds?: string[];
  /** Vorauswahl für neue Bestellungen (bei genau einer angebotenen Bezahlart). */
  defaultPaymentMethod?: PizzaPaymentMethod | null;
}

export function addLine(context: DatabaseContext, input: AddLineInput) {
  return context.sqlite.transaction(() => addLineInTransaction(context, input))();
}

function addLineInTransaction(context: DatabaseContext, input: AddLineInput) {
  const session = getSession(context, input.sessionId);
  assertSessionOpen(session);
  assertValidQty(input.qty);
  const note = normalizeNote(input.customNote);
  assertValidNote(note);

  const variantWithItem = getVariantWithItem(context, input.variantId);
  if (!variantWithItem) {
    throw new PizzaOrderError("variant_missing", "Variante nicht gefunden", 404);
  }
  const extraIds = input.extraIds ?? [];
  assertExtraIdsShape(extraIds);
  const extras = resolveNewExtras(context, extraIds, variantWithItem.item.categoryId, input.variantId);

  const order = getOrCreateOrder(
    context,
    input.sessionId,
    input.userId,
    input.defaultPaymentMethod ?? null
  );
  const existingLines = listLinesForOrder(context, order.id);
  assertCanAddLine(existingLines);

  const id = randomUUID();
  context.db
    .insert(pizzaOrderLines)
    .values({
      id,
      orderId: order.id,
      variantId: input.variantId,
      qty: input.qty,
      priceCentsSnapshot: variantWithItem.variant.priceCents,
      customNote: note,
      createdAt: nowIso()
    })
    .run();
  insertLineExtras(context, id, extras);

  return { lineId: id, orderId: order.id };
}

export interface UpdateLineInput {
  lineId: string;
  userId: string;
  qty?: number;
  customNote?: string | null;
  /** Ersetzt die Extras der Position; behaltene Extras behalten ihren Preis-Snapshot. */
  extraIds?: string[];
}

function findLineWithOrder(context: DatabaseContext, lineId: string) {
  const line = context.db
    .select()
    .from(pizzaOrderLines)
    .where(eq(pizzaOrderLines.id, lineId))
    .get();
  if (!line) return null;
  const order = context.db
    .select()
    .from(pizzaOrders)
    .where(eq(pizzaOrders.id, line.orderId))
    .get();
  if (!order) return null;
  return { line, order };
}

export function updateLine(context: DatabaseContext, input: UpdateLineInput) {
  context.sqlite.transaction(() => updateLineInTransaction(context, input))();
}

function updateLineInTransaction(context: DatabaseContext, input: UpdateLineInput) {
  const found = findLineWithOrder(context, input.lineId);
  if (!found) throw new PizzaOrderError("line_missing", "Position nicht gefunden", 404);
  if (found.order.userId !== input.userId) {
    throw new PizzaOrderError("forbidden", "Position gehört einem anderen User", 403);
  }
  const session = getSession(context, found.order.sessionId);
  assertSessionOpen(session);

  const update: Partial<typeof pizzaOrderLines.$inferInsert> = {};
  if (typeof input.qty === "number") {
    assertValidQty(input.qty);
    update.qty = input.qty;
  }
  if (input.customNote !== undefined) {
    const note = normalizeNote(input.customNote);
    assertValidNote(note);
    update.customNote = note;
  }
  if (input.extraIds !== undefined) {
    replaceLineExtras(context, found.line, input.extraIds);
  }
  if (Object.keys(update).length === 0) return;
  context.db.update(pizzaOrderLines).set(update).where(eq(pizzaOrderLines.id, input.lineId)).run();
}

function replaceLineExtras(
  context: DatabaseContext,
  line: { id: string; variantId: string },
  extraIds: string[]
) {
  assertExtraIdsShape(extraIds);
  const current = context.db
    .select()
    .from(pizzaOrderLineExtras)
    .where(eq(pizzaOrderLineExtras.lineId, line.id))
    .all();
  const currentIds = new Set(current.map((extra) => extra.extraId));
  const wanted = new Set(extraIds);
  const toAdd = extraIds.filter((id) => !currentIds.has(id));
  if (toAdd.length > 0) {
    const variantWithItem = getVariantWithItem(context, line.variantId);
    if (!variantWithItem) {
      throw new PizzaOrderError("pizza_extra_nicht_verfuegbar", "Extra ist für diesen Artikel nicht verfügbar");
    }
    insertLineExtras(
      context,
      line.id,
      resolveNewExtras(context, toAdd, variantWithItem.item.categoryId, line.variantId)
    );
  }
  for (const extra of current) {
    if (!wanted.has(extra.extraId)) {
      context.sqlite
        .prepare("DELETE FROM pizza_order_line_extras WHERE line_id = ? AND extra_id = ?")
        .run(line.id, extra.extraId);
    }
  }
}

export function deleteLine(context: DatabaseContext, lineId: string, userId: string) {
  const found = findLineWithOrder(context, lineId);
  if (!found) return;
  if (found.order.userId !== userId) {
    throw new PizzaOrderError("forbidden", "Position gehört einem anderen User", 403);
  }
  const session = getSession(context, found.order.sessionId);
  assertSessionOpen(session);
  context.db.delete(pizzaOrderLines).where(eq(pizzaOrderLines.id, lineId)).run();
}

export function listOrdersForSession(context: DatabaseContext, sessionId: string) {
  const orders = context.db
    .select()
    .from(pizzaOrders)
    .where(eq(pizzaOrders.sessionId, sessionId))
    .all();

  return orders.map((order) => ({
    ...order,
    lines: listLinesForOrder(context, order.id)
  }));
}

export function getOrderForUser(context: DatabaseContext, sessionId: string, userId: string) {
  const order = context.db
    .select()
    .from(pizzaOrders)
    .where(and(eq(pizzaOrders.sessionId, sessionId), eq(pizzaOrders.userId, userId)))
    .get();
  if (!order) return null;
  return { ...order, lines: listLinesForOrder(context, order.id) };
}

export function cancelOpenOrderForUser(context: DatabaseContext, sessionId: string, userId: string) {
  const order = context.db
    .select()
    .from(pizzaOrders)
    .where(and(eq(pizzaOrders.sessionId, sessionId), eq(pizzaOrders.userId, userId)))
    .get();
  if (!order) return false;
  context.db.delete(pizzaOrders).where(eq(pizzaOrders.id, order.id)).run();
  return true;
}

export type PaymentMethod = PizzaPaymentMethod;

/**
 * Gast wählt seine Bezahlart (Bargeld/PayPal). Nur solange die Bestellung nicht als bezahlt
 * markiert ist und nur aus den aktuell angebotenen Bezahlarten.
 */
export function setPaymentMethod(
  context: DatabaseContext,
  input: {
    sessionId: string;
    userId: string;
    method: PizzaPaymentMethod;
    offered: PizzaPaymentMethod[];
  }
) {
  if (!input.offered.includes(input.method)) {
    throw new PizzaOrderError(
      "pizza_bezahlart_nicht_verfuegbar",
      "Diese Bezahlart wird nicht angeboten"
    );
  }
  const order = context.db
    .select()
    .from(pizzaOrders)
    .where(and(eq(pizzaOrders.sessionId, input.sessionId), eq(pizzaOrders.userId, input.userId)))
    .get();
  if (!order) {
    throw new PizzaOrderError("pizza_bestellung_nicht_gefunden", "Keine eigene Bestellung", 404);
  }
  assertNotArchived(getSession(context, order.sessionId));
  if (order.paymentStatus !== "unpaid") {
    throw new PizzaOrderError("pizza_bereits_bezahlt", "Bestellung ist bereits bezahlt", 409);
  }
  context.db
    .update(pizzaOrders)
    .set({ paymentMethod: input.method, updatedAt: nowIso() })
    .where(eq(pizzaOrders.id, order.id))
    .run();
  return order.id;
}

export function markPayment(
  context: DatabaseContext,
  input: { orderId: string; method: PaymentMethod | "unpaid"; adminId: string }
) {
  const order = context.db
    .select()
    .from(pizzaOrders)
    .where(eq(pizzaOrders.id, input.orderId))
    .get();
  if (!order) throw new PizzaOrderError("order_missing", "Bestellung nicht gefunden", 404);
  const session = getSession(context, order.sessionId);
  assertNotArchived(session);
  if (!canMarkPayment(session.state as never)) {
    throw new PizzaOrderError(
      "session_not_locked",
      "Zahlung kann erst nach Schließen der Bestellung gebucht werden"
    );
  }

  const now = nowIso();
  const status =
    input.method === "paypal"
      ? "paid_paypal"
      : input.method === "cash"
        ? "paid_cash"
        : "unpaid";

  context.db
    .update(pizzaOrders)
    .set({
      paymentStatus: status,
      // Bezahlt markiert = tatsächlich genutzte Bezahlart; "offen" behält die Wahl des Gasts.
      paymentMethod: input.method === "unpaid" ? order.paymentMethod : input.method,
      paidAt: status === "unpaid" ? null : now,
      paidByAdminId: status === "unpaid" ? null : input.adminId,
      updatedAt: now
    })
    .where(eq(pizzaOrders.id, input.orderId))
    .run();
}

export { PizzaOrderLimitError };

/** Nach einer Änderung der Bezahlarten: offene Bestellungen mit nicht mehr angebotener Bezahlart neu setzen. */
export function resetUnofferedPaymentMethods(
  context: DatabaseContext,
  sessionId: string,
  offered: PizzaPaymentMethod[],
  fallback: PizzaPaymentMethod | null
) {
  const placeholders = offered.map(() => "?").join(", ");
  context.sqlite
    .prepare(
      `UPDATE pizza_orders SET payment_method = ?, updated_at = ?
       WHERE session_id = ? AND payment_status = 'unpaid'
         AND payment_method IS NOT NULL AND payment_method NOT IN (${placeholders})`
    )
    .run(fallback, nowIso(), sessionId, ...offered);
}
