import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseContext } from "../../db/client";
import { pizzaSessions } from "../../db/schema";
import { AppError } from "../../http/errors";
import { PizzaLifecycleError, nextState, type PizzaSessionTransition } from "./lifecycle";
import { countActiveItems } from "./menu";

function nowIso() {
  return new Date().toISOString();
}

export class PizzaSessionError extends AppError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
  }
}

/**
 * Aktuelle (nicht archivierte) Bestellrunde eines Events — die jüngste ohne `archivedAt`.
 * `mainEventId` null = die Runde ohne Event. Jedes Event hat seine eigene aktuelle Runde.
 */
export function getActiveSession(context: DatabaseContext, mainEventId: string | null = null) {
  return context.db
    .select()
    .from(pizzaSessions)
    .where(
      and(
        isNull(pizzaSessions.archivedAt),
        mainEventId ? eq(pizzaSessions.mainEventId, mainEventId) : isNull(pizzaSessions.mainEventId)
      )
    )
    .orderBy(desc(pizzaSessions.createdAt))
    .limit(1)
    .all()[0];
}

/** Alle aktuellen (nicht archivierten) Runden, je Event und ohne Event. */
export function listActiveSessions(context: DatabaseContext) {
  return context.db.select().from(pizzaSessions).where(isNull(pizzaSessions.archivedAt)).all();
}

export function getSessionById(context: DatabaseContext, sessionId: string) {
  return context.db.select().from(pizzaSessions).where(eq(pizzaSessions.id, sessionId)).get();
}

function markArchived(context: DatabaseContext, sessionId: string, actor: { id: string } | null) {
  const now = nowIso();
  // Leere Bestellungen (alle Positionen entfernt) gehören nicht ins Archiv.
  context.sqlite
    .prepare(
      `DELETE FROM pizza_orders
       WHERE session_id = ?
         AND NOT EXISTS (SELECT 1 FROM pizza_order_lines l WHERE l.order_id = pizza_orders.id)`
    )
    .run(sessionId);
  context.db
    .update(pizzaSessions)
    .set({ archivedAt: now, archivedByUserId: actor?.id ?? null, updatedAt: now })
    .where(and(eq(pizzaSessions.id, sessionId), isNull(pizzaSessions.archivedAt)))
    .run();
}

/**
 * Liefert die aktuelle Runde oder legt eine neue Entwurfsrunde an. Eine bereits gelieferte
 * Runde wird dabei automatisch archiviert, damit ihre Bestellungen nicht in die neue Runde
 * hineinragen.
 */
export function getOrCreateDraftSession(
  context: DatabaseContext,
  actor: { id: string } | null = null,
  mainEventId: string | null = null
) {
  const existing = getActiveSession(context, mainEventId);
  if (existing && existing.state !== "delivered") return existing;
  if (existing) markArchived(context, existing.id, actor);

  const id = randomUUID();
  const now = nowIso();
  context.db
    .insert(pizzaSessions)
    .values({
      id,
      mainEventId,
      state: "draft",
      createdAt: now,
      updatedAt: now
    })
    .run();
  return getSessionById(context, id)!;
}

export function transitionSession(
  context: DatabaseContext,
  transition: PizzaSessionTransition,
  actor: { id: string },
  label?: string | null,
  mainEventId: string | null = null
) {
  // Transaktion: scheitert der Übergang, bleiben Archivierung und neue Entwurfsrunde aus.
  return context.sqlite.transaction(() => applyTransition(context, transition, actor, label, mainEventId))();
}

function applyTransition(
  context: DatabaseContext,
  transition: PizzaSessionTransition,
  actor: { id: string },
  label: string | null | undefined,
  mainEventId: string | null
) {
  if (transition === "open" && countActiveItems(context) === 0) {
    throw new PizzaLifecycleError("menu_empty", "Mindestens ein aktiver Menüeintrag erforderlich");
  }
  // Nur „open“ beginnt eine neue Runde. Ein zweites „deliver“ (Doppelklick) auf eine gelieferte
  // Runde darf sie nicht archivieren und keinen leeren Entwurf anlegen.
  const session =
    transition === "open"
      ? getOrCreateDraftSession(context, actor, mainEventId)
      : getActiveSession(context, mainEventId);
  if (!session) {
    throw new PizzaLifecycleError("invalid_transition", `Übergang ${transition} ohne aktive Runde nicht erlaubt`);
  }

  const target = nextState(session.state, transition);
  const now = nowIso();

  const update: Partial<typeof pizzaSessions.$inferInsert> = {
    state: target,
    updatedAt: now
  };

  if (transition === "open") {
    update.openedAt = now;
    update.openedByUserId = actor.id;
    update.lockedAt = null;
    update.lockedByUserId = null;
    update.deliveredAt = null;
    update.deliveredByUserId = null;
    if (typeof label === "string") update.label = label.trim() || null;
  } else if (transition === "lock") {
    update.lockedAt = now;
    update.lockedByUserId = actor.id;
  } else if (transition === "deliver") {
    update.deliveredAt = now;
    update.deliveredByUserId = actor.id;
  } else if (transition === "reopen") {
    update.lockedAt = null;
    update.lockedByUserId = null;
  }

  context.db.update(pizzaSessions).set(update).where(eq(pizzaSessions.id, session.id)).run();

  return getSessionById(context, session.id)!;
}

/**
 * Archiviert eine Runde in beliebigem Zustand (auch hängengebliebene offene/geschlossene
 * Runden). Danach zeigt die aktuelle Ansicht keine Runde mehr, und eine neue kann starten.
 */
export function archiveSession(context: DatabaseContext, sessionId: string, actor: { id: string }) {
  const session = getSessionById(context, sessionId);
  if (!session) {
    throw new PizzaSessionError("pizza_runde_nicht_gefunden", "Bestellrunde nicht gefunden", 404);
  }
  if (session.archivedAt) {
    throw new PizzaSessionError(
      "pizza_runde_bereits_archiviert",
      "Bestellrunde ist bereits archiviert",
      409
    );
  }
  context.sqlite.transaction(() => markArchived(context, sessionId, actor))();
  return getSessionById(context, sessionId)!;
}

export interface ArchivedPizzaSessionSummary {
  id: string;
  state: string;
  label: string | null;
  /** Event der Runde (null = ohne Event). */
  mainEventId: string | null;
  createdAt: string;
  openedAt: string | null;
  deliveredAt: string | null;
  archivedAt: string;
  orderCount: number;
  unpaidCount: number;
  totalCents: number;
}

export function listArchivedSessions(
  context: DatabaseContext,
  limit = 50
): ArchivedPizzaSessionSummary[] {
  const rows = context.db
    .select()
    .from(pizzaSessions)
    .where(isNotNull(pizzaSessions.archivedAt))
    .orderBy(desc(pizzaSessions.archivedAt))
    .limit(limit)
    .all();

  const statsStatement = context.sqlite.prepare(
    `SELECT
       COUNT(DISTINCT CASE WHEN l.id IS NOT NULL THEN o.id END) AS orderCount,
       COUNT(DISTINCT CASE WHEN l.id IS NOT NULL AND o.payment_status = 'unpaid' THEN o.id END) AS unpaidCount,
       COALESCE(SUM(l.qty * (l.price_cents_snapshot + COALESCE(
         (SELECT SUM(e.price_cents_snapshot) FROM pizza_order_line_extras e WHERE e.line_id = l.id), 0
       ))), 0) AS totalCents
     FROM pizza_orders o
     LEFT JOIN pizza_order_lines l ON l.order_id = o.id
     WHERE o.session_id = ?`
  );

  return rows.map((row) => {
    const stats = statsStatement.get(row.id) as {
      orderCount: number;
      unpaidCount: number;
      totalCents: number;
    };
    return {
      id: row.id,
      state: row.state,
      label: row.label,
      mainEventId: row.mainEventId,
      createdAt: row.createdAt,
      openedAt: row.openedAt,
      deliveredAt: row.deliveredAt,
      archivedAt: row.archivedAt!,
      orderCount: stats.orderCount,
      unpaidCount: stats.unpaidCount,
      totalCents: stats.totalCents
    };
  });
}

/**
 * Löscht eine archivierte Runde endgültig samt Bestellungen und Zeilen (FK-Cascade).
 * Nur archivierte Runden, damit nie eine laufende Bestellung versehentlich verschwindet.
 */
export function deleteArchivedSession(context: DatabaseContext, sessionId: string) {
  const session = getSessionById(context, sessionId);
  if (!session) {
    throw new PizzaSessionError("pizza_runde_nicht_gefunden", "Bestellrunde nicht gefunden", 404);
  }
  if (!session.archivedAt) {
    throw new PizzaSessionError(
      "pizza_runde_nicht_archiviert",
      "Nur archivierte Bestellrunden können gelöscht werden",
      409
    );
  }
  const orderCount = (
    context.sqlite
      .prepare("SELECT COUNT(*) AS count FROM pizza_orders WHERE session_id = ?")
      .get(sessionId) as { count: number }
  ).count;
  // pizza_orders und pizza_order_lines hängen per ON DELETE CASCADE an der Runde.
  context.db.delete(pizzaSessions).where(eq(pizzaSessions.id, sessionId)).run();
  return { session, orderCount };
}
