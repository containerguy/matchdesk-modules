import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { DatabaseContext } from "../db/client";
import { pizzaMenuItems, pizzaMenuVariants, pizzaOrders, users } from "../db/schema";
import {
  deleteCategory,
  findCategoryByName,
  getCategoryById,
  listActiveCategories,
  listCategories,
  PIZZA_CATEGORY_NAME_MAX_LEN,
  reorderCategories,
  setCategoryActive,
  upsertCategory
} from "../domain/pizza/categories";
import {
  getExtraById,
  listActiveExtras,
  listExtras,
  PIZZA_EXTRA_NAME_MAX_LEN,
  PIZZA_MAX_EXTRAS_PER_LINE,
  removeExtra,
  setExtraActive,
  upsertExtra
} from "../domain/pizza/extras";
import {
  getItemById,
  getVariantById,
  listActiveMenu,
  listAllMenu,
  removeItem,
  removeVariant,
  setItemActive,
  setVariantActive,
  upsertItem,
  upsertVariant,
  type PizzaMenuItemRow
} from "../domain/pizza/menu";
import {
  applyMenuTransfer,
  buildMenuDocument,
  extrasToCsv,
  MENU_TRANSFER_MAX_CHARS,
  menuToCsv,
  menuToYaml,
  previewMenuTransfer
} from "../domain/pizza/menu-transfer";
import {
  addLine,
  deleteLine,
  getOrderForUser,
  listOrdersForSession,
  markPayment,
  resetUnofferedPaymentMethods,
  setPaymentMethod,
  updateLine
} from "../domain/pizza/orders";
import { defaultPaymentMethod, offeredPaymentMethods } from "../domain/pizza/payment";
import {
  archiveSession,
  deleteArchivedSession,
  getActiveSession,
  listActiveSessions,
  getSessionById,
  listArchivedSessions,
  transitionSession
} from "../domain/pizza/sessions";
import { guestTotals, lineTotalCents } from "../domain/pizza/totals";
import { buildKassenlistePdf, buildPizzeriaPdf } from "../pdf/pizza-print";
import {
  broadcastEventsChanged,
  can,
  canManagePizza,
  canSeeMainEvent,
  currentMainEventIdOf,
  getMainEvent,
  participantStatus,
  readSettings,
  requireUser,
  requireWrite,
  scopedEventIds,
  sendPushToEnabledUsers,
  sendPushToMainEventParticipants,
  tryWriteAuditLog,
  writeSettings
} from "../core";
import { handleDomainError } from "./errors";

const paymentModeSchema = z.object({
  pizzaPaymentMethods: z.enum(["cash_and_paypal", "cash_only", "paypal_only"])
});

const transitionSchema = z.object({
  transition: z.enum(["open", "lock", "deliver", "reopen"]),
  label: z.string().trim().max(120).optional()
});

const extraIdsSchema = z.array(z.string().min(1).max(64)).max(PIZZA_MAX_EXTRAS_PER_LINE);

const addLineSchema = z.object({
  variantId: z.string().min(1),
  qty: z.number().int().min(1).max(3),
  customNote: z.string().trim().max(200).nullable().optional(),
  extraIds: extraIdsSchema.optional()
});

const updateLineSchema = z.object({
  qty: z.number().int().min(1).max(3).optional(),
  customNote: z.string().trim().max(200).nullable().optional(),
  extraIds: extraIdsSchema.optional()
});

const extraUpsertSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(PIZZA_EXTRA_NAME_MAX_LEN),
  priceCents: z.number().int().min(0).max(100_000),
  categoryIds: z.array(z.string().min(1).max(64)).max(100),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
});

const paymentSchema = z.object({
  method: z.enum(["paypal", "cash", "unpaid"])
});

const paymentMethodSchema = z.object({
  method: z.enum(["paypal", "cash"])
});

const itemUpsertSchema = z.object({
  id: z.string().optional(),
  number: z.string().trim().max(16).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  ingredients: z.string().trim().max(500).nullable().optional(),
  allergens: z.string().trim().max(120).nullable().optional(),
  categoryId: z.string().min(1).max(64),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional()
});

const categoryNameSchema = z.string().trim().min(1).max(PIZZA_CATEGORY_NAME_MAX_LEN);

const categoryUpsertSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: categoryNameSchema,
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  active: z.boolean().optional()
});

const categoryOrderSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200)
});

const variantUpsertSchema = z.object({
  id: z.string().optional(),
  itemId: z.string().min(1),
  sizeLabel: z.string().trim().max(32).nullable(),
  priceCents: z.number().int().min(0).max(100_000),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional()
});

const activeSchema = z.object({ active: z.boolean() });

const menuImportSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        number: z.string().trim().max(16).nullable().optional(),
        name: z.string().trim().min(1).max(120),
        ingredients: z.string().trim().max(500).nullable().optional(),
        allergens: z.string().trim().max(120).nullable().optional(),
        /** Bevorzugt; fehlt sie oder ist unbekannt, gilt `category` (Name, auch alte Exporte „pizza“/„pasta“). */
        categoryId: z.string().max(64).optional(),
        category: categoryNameSchema.optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
        variants: z
          .array(
            z.object({
              id: z.string().optional(),
              sizeLabel: z.string().trim().max(32).nullable(),
              priceCents: z.number().int().min(0).max(100_000),
              sortOrder: z.number().int().optional(),
              active: z.boolean().optional()
            })
          )
          .max(8)
      }).refine((item) => Boolean(item.categoryId || item.category), {
        message: "categoryId oder category erforderlich",
        path: ["category"]
      })
    )
    .max(500),
  categories: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        name: categoryNameSchema,
        sortOrder: z.number().int().min(0).max(100_000).optional(),
        active: z.boolean().optional()
      })
    )
    .max(100)
    .optional()
});

const menuTransferSchema = z.object({
  format: z.enum(["yaml", "csv", "extras_csv"]),
  content: z.string().min(1).max(MENU_TRANSFER_MAX_CHARS),
  /** Nur beim Übernehmen: `menuVersion` der gezeigten Vorschau. */
  expectedVersion: z.string().max(64).optional(),
  /** Nur beim Übernehmen: Bestätigung der Warnung „viele Einträge werden entfernt“. */
  confirmRemovals: z.boolean().optional()
});

function parseMenuTransferBody(body: unknown, response: Response) {
  const parsed = menuTransferSchema.safeParse(body);
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((issue) => issue.code === "too_big");
    response.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "pizza_import_zu_gross" : "ungueltige_eingabe" });
    return null;
  }
  return parsed.data;
}

function sendDownload(response: Response, contentType: string, filename: string, body: string) {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  response.setHeader("Cache-Control", "no-store");
  response.send(body);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

type LineLabel = {
  itemNumber: string | null;
  itemName: string;
  sizeLabel: string | null;
  itemId: string | null;
  categoryId: string | null;
};

/**
 * Bezeichnungen aller Varianten (auch deaktivierter), damit vergangene Bestellzeilen ihren
 * Namen behalten, selbst wenn der Artikel nicht mehr im bestellbaren Menü steht.
 */
function buildLineLabels(menu: PizzaMenuItemRow[]) {
  const labels = new Map<string, LineLabel>();
  for (const item of menu) {
    for (const variant of item.variants) {
      labels.set(variant.id, {
        itemNumber: item.number,
        itemName: item.name,
        sizeLabel: variant.sizeLabel,
        itemId: item.id,
        categoryId: item.categoryId
      });
    }
  }
  return labels;
}

function labelFor(labels: Map<string, LineLabel>, variantId: string): LineLabel {
  return (
    labels.get(variantId) ?? { itemNumber: null, itemName: "[entfernt]", sizeLabel: null, itemId: null, categoryId: null }
  );
}

type OrderWithLines = ReturnType<typeof listOrdersForSession>[number];

function decorateOrder(order: OrderWithLines, labels: Map<string, LineLabel>) {
  return {
    ...order,
    lines: order.lines.map((line) => ({ ...line, ...labelFor(labels, line.variantId) }))
  };
}

function loadUsers(context: DatabaseContext, userIds: string[]) {
  const byId = new Map<string, { username: string; displayName: string | null }>();
  for (const userId of new Set(userIds)) {
    const found = context.db.select().from(users).where(eq(users.id, userId)).get();
    if (found) {
      byId.set(userId, { username: found.username, displayName: found.displayName });
    }
  }
  return byId;
}

function loadSerializedState(context: DatabaseContext, actor: PizzaActor, scope: PizzaScope) {
  const currentUserId = actor.id;
  const settings = readSettings(context);
  const session = getActiveSession(context, scope.mainEventId);
  const menu = listActiveMenu(context);
  const categories = listActiveCategories(context);
  const activeCategoryIds = new Set(categories.map((category) => category.id));
  const labels = buildLineLabels(listAllMenu(context));
  const myOrder = session ? getOrderForUser(context, session.id, currentUserId) : null;
  const allOrders = session ? listOrdersForSession(context, session.id) : [];
  const usersById = loadUsers(
    context,
    allOrders.map((order) => order.userId)
  );

  return {
    /** Event der angezeigten Bestellrunde (null = Runde ohne Event). */
    mainEventId: scope.mainEventId,
    mainEventName: scope.mainEventName,
    /** Darf bestellen: bei Event-Runden nur Teilnehmer („dabei“) und Pizza-Verwalter des Events. */
    canOrder: canOrderInScope(context, actor, scope),
    /** Darf diese Bestellrunde verwalten (global oder per Event-Vergabe). */
    canManage: can(context, actor, "pizza.manage", { mainEventId: scope.mainEventId }),
    /** Darf Speisekarte und Bezahlarten pflegen (nur global). */
    canManageMenu: canManagePizza(context, actor),
    session: session ?? null,
    /** Aktive Kategorien in Sortierreihenfolge; inaktive sind für Gäste unsichtbar. */
    categories: categories.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    menu,
    /** Aktive Extras; je Artikel gelten nur die seiner Kategorie. */
    extras: listActiveExtras(context)
      .map((extra) => ({ ...extra, categoryIds: extra.categoryIds.filter((id) => activeCategoryIds.has(id)) }))
      .filter((extra) => extra.categoryIds.length > 0),
    paymentMethods: offeredPaymentMethods(settings),
    /** Einstellung hinter `paymentMethods`; ab manager im Pizza-Panel änderbar. */
    paymentMode: settings.pizzaPaymentMethods,
    /** Empfänger für Bargeld/PayPal (früher aus den Kern-Einstellungen). */
    payment: {
      paypalHandle: settings.pizzaPaypalHandle,
      paypalName: settings.pizzaPaypalName,
      cashRecipient: settings.pizzaCashRecipient
    },
    myOrder: myOrder ? decorateOrder(myOrder, labels) : null,
    orders: allOrders.map((order) => ({
      ...decorateOrder(order, labels),
      user: usersById.get(order.userId) ?? { username: "unbekannt", displayName: null }
    })),
    guestTotals: guestTotals(
      allOrders.map((order) => ({
        userId: order.userId,
        lines: order.lines.map((line) => ({
          qty: line.qty,
          priceCentsSnapshot: line.priceCentsSnapshot,
          extras: line.extras
        }))
      }))
    )
  };
}

type PizzaActor = NonNullable<ReturnType<typeof requireUser>>;

/** Bestellrunden-Bereich: ein Event oder die Runde ohne Event (`mainEventId` null). */
type PizzaScope = { mainEventId: string | null; mainEventName: string | null; ended: boolean };

/**
 * Bereich aus `?mainEventId=<id>` bzw. `?mainEventId=none`; ohne Angabe gilt das aktuelle Event
 * des Benutzers (globaler Umschalter), sonst die Runde ohne Event.
 */
function resolveScope(
  context: DatabaseContext,
  request: Request,
  actor: PizzaActor
): { ok: true; scope: PizzaScope } | { ok: false; status: number; error: string } {
  const raw = typeof request.query.mainEventId === "string" ? request.query.mainEventId : undefined;
  const requested =
    raw === undefined ? currentMainEventIdOf(context, actor) : raw === "none" || raw === "" ? null : raw;
  if (!requested) {
    return { ok: true, scope: { mainEventId: null, mainEventName: null, ended: false } };
  }
  const event = getMainEvent(context, requested);
  if (!event || !canSeeMainEvent(context, actor, event)) {
    return { ok: false, status: 404, error: "hauptevent_nicht_gefunden" };
  }
  return { ok: true, scope: { mainEventId: event.id, mainEventName: event.name, ended: event.status === "ended" } };
}

function requireScope(context: DatabaseContext, request: Request, response: Response, actor: PizzaActor) {
  const resolved = resolveScope(context, request, actor);
  if (!resolved.ok) {
    response.status(resolved.status).json({ error: resolved.error });
    return null;
  }
  return resolved.scope;
}

/** Event-Runden: bestellen dürfen Teilnehmer („dabei“) und wer die Pizza des Events verwaltet. */
function canOrderInScope(context: DatabaseContext, actor: PizzaActor, scope: PizzaScope) {
  if (!scope.mainEventId) return true;
  if (scope.ended) return false;
  if (can(context, actor, "pizza.manage", { mainEventId: scope.mainEventId })) return true;
  const participation = { status: participantStatus(scope.mainEventId, actor.id) };
  return participation?.status === "joined";
}

/** Pizza-Verwalter für eine Bestellrunde (mit Event: auch per Vergabe nur für dieses Event). */
function requireScopedPizzaManager(
  context: DatabaseContext,
  request: Request,
  response: Response,
  mainEventId: string | null
) {
  const actor = requireUser(context, request)!;
  if (!can(context, actor, "pizza.manage", { mainEventId })) {
    response.status(403).json({ error: "pizza_manager_erforderlich" });
    return null;
  }
  return actor;
}

/** Pizza-Verwaltung global oder für mindestens ein Event. */
function canManagePizzaSomewhere(context: DatabaseContext, actor: PizzaActor) {
  return canManagePizza(context, actor) || scopedEventIds(context, actor, "pizza.manage").length > 0;
}

/** Speisekarte und Bezahlarten: nur mit globalem Recht. */
function requirePizzaManager(context: DatabaseContext, request: Request, response: Response) {
  const actor = requireUser(context, request)!;
  if (!canManagePizza(context, actor)) {
    response.status(403).json({ error: "pizza_manager_erforderlich" });
    return null;
  }
  return actor;
}

function respondDomainError(error: unknown, response: Response, logLabel: string) {
  if (!handleDomainError(error, response)) {
    console.error(`[Matchdesk] ${logLabel}`, error);
    response.status(500).json({ error: "interner_fehler" });
  }
}

/**
 * Druck-Routen: Standard ist die aktuelle Runde des Bereichs, `?sessionId=` erlaubt archivierte
 * Runden. Verwalten muss man die Runde (global oder für ihr Event).
 */
function resolvePrintSession(context: DatabaseContext, request: Request, response: Response) {
  const actor = requireUser(context, request)!;
  const requested = typeof request.query.sessionId === "string" ? request.query.sessionId : "";
  let session;
  if (requested) {
    session = getSessionById(context, requested);
  } else {
    const scope = requireScope(context, request, response, actor);
    if (!scope) return undefined;
    if (!requireScopedPizzaManager(context, request, response, scope.mainEventId)) return undefined;
    session = getActiveSession(context, scope.mainEventId);
  }
  if (!session) {
    response.status(404).json({ error: "keine_session" });
    return undefined;
  }
  if (!requireScopedPizzaManager(context, request, response, session.mainEventId)) return undefined;
  return session;
}

/** Event einer Bestellung (über ihre Runde) für die Rechteprüfung. */
function mainEventIdOfOrder(context: DatabaseContext, orderId: string) {
  const order = context.db.select({ sessionId: pizzaOrders.sessionId }).from(pizzaOrders).where(eq(pizzaOrders.id, orderId)).get();
  return order ? (getSessionById(context, order.sessionId)?.mainEventId ?? null) : null;
}

export function createPizzaRouter(context: DatabaseContext) {
  const router = Router();

  router.use((request, response, next) => {
    if (!requireUser(context, request)) {
      response.status(401).json({ error: "nicht_angemeldet" });
      return;
    }
    next();
  });

  router.use((request, response, next) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
      if (!requireWrite(request, response)) return;
    }
    next();
  });

  router.get("/state", (request, response) => {
    const actor = requireUser(context, request)!;
    const scope = requireScope(context, request, response, actor);
    if (!scope) return;
    response.json(loadSerializedState(context, actor, scope));
  });

  router.post("/transitions", (request, response) => {
    const user = requireUser(context, request)!;
    const scope = requireScope(context, request, response, user);
    if (!scope) return;
    const actor = requireScopedPizzaManager(context, request, response, scope.mainEventId);
    if (!actor) return;
    const parsed = transitionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltiger_uebergang" });
      return;
    }
    if (scope.ended && parsed.data.transition === "open") {
      response.status(409).json({ error: "hauptevent_beendet" });
      return;
    }
    try {
      const session = transitionSession(
        context,
        parsed.data.transition,
        actor,
        parsed.data.label,
        scope.mainEventId
      );
      tryWriteAuditLog(context, {
        actor,
        action: `pizza.session.${parsed.data.transition}`,
        entityType: "pizza_session",
        entityId: session.id,
        summary: `Pizzabestellung: ${parsed.data.transition}${scope.mainEventName ? ` (${scope.mainEventName})` : ""}`,
        metadata: { mainEventId: scope.mainEventId }
      });
      broadcastEventsChanged(`pizza_session_${parsed.data.transition}`);

      if (parsed.data.transition === "open") {
        const payload = {
          title: scope.mainEventName ? `Pizzabestellung offen · ${scope.mainEventName}` : "Pizzabestellung offen",
          body: `Bestelle jetzt — Admin schließt manuell.`,
          url: `/#m/pizza`
        };
        // Event-Runden benachrichtigen nur die Teilnehmer des Events.
        (scope.mainEventId
          ? sendPushToMainEventParticipants(context, scope.mainEventId, payload)
          : sendPushToEnabledUsers(context, payload)
        ).catch(() => undefined);
      }

      response.json({ session });
    } catch (error) {
      respondDomainError(error, response, "pizza transition failed");
    }
  });

  /** Bezahlarten ab manager (René, PR #14). Andere Einstellungen bleiben admin vorbehalten. */
  router.put("/payment-mode", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = paymentModeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_settings" });
      return;
    }
    const current = readSettings(context);
    // Nur diesen einen Schlüssel schreiben; die übrigen Einstellungen bleiben unberührt.
    writeSettings(context, { pizzaPaymentMethods: parsed.data.pizzaPaymentMethods }, actor);
    // Offene Bestellungen der aktuellen Runde mit einer nicht mehr angebotenen Bezahlart neu setzen
    // (eine verbleibende Bezahlart wird vorausgewählt, sonst wählt der Gast neu).
    const offered = offeredPaymentMethods(readSettings(context));
    // Alle aktuellen Runden (je Event und ohne Event) anpassen.
    for (const active of listActiveSessions(context)) {
      resetUnofferedPaymentMethods(context, active.id, offered, defaultPaymentMethod(offered));
    }
    tryWriteAuditLog(context, {
      actor,
      action: "pizza.payment_mode",
      entityType: "settings",
      entityId: "app",
      summary: `Pizza-Bezahlarten: ${parsed.data.pizzaPaymentMethods}`,
      metadata: { from: current.pizzaPaymentMethods, to: parsed.data.pizzaPaymentMethods }
    });
    broadcastEventsChanged("pizza_payment_mode");
    response.json({ paymentMode: parsed.data.pizzaPaymentMethods, paymentMethods: offered });
  });

  router.get("/sessions/archived", (request, response) => {
    const actor = requireUser(context, request)!;
    // Wer Pizza nur für einzelne Events verwaltet, sieht nur deren archivierte Runden.
    const sessions = listArchivedSessions(context).filter((session) =>
      can(context, actor, "pizza.manage", { mainEventId: session.mainEventId })
    );
    if (sessions.length === 0 && !canManagePizzaSomewhere(context, actor)) {
      response.status(403).json({ error: "pizza_manager_erforderlich" });
      return;
    }
    response.json({
      sessions: sessions.map((session) => ({
        ...session,
        mainEventName: session.mainEventId ? (getMainEvent(context, session.mainEventId)?.name ?? null) : null
      }))
    });
  });

  router.post("/sessions/:id/archive", (request, response) => {
    const actor = requireScopedPizzaManager(
      context,
      request,
      response,
      getSessionById(context, request.params.id)?.mainEventId ?? null
    );
    if (!actor) return;
    try {
      const session = archiveSession(context, request.params.id, actor);
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.session.archive",
        entityType: "pizza_session",
        entityId: session.id,
        summary: `Pizzarunde archiviert${session.label ? `: ${session.label}` : ""}`,
        metadata: { state: session.state }
      });
      broadcastEventsChanged("pizza_session_archived");
      response.json({ session });
    } catch (error) {
      respondDomainError(error, response, "pizza archive failed");
    }
  });

  router.delete("/sessions/:id", (request, response) => {
    const actor = requireScopedPizzaManager(
      context,
      request,
      response,
      getSessionById(context, request.params.id)?.mainEventId ?? null
    );
    if (!actor) return;
    try {
      const { session, orderCount } = deleteArchivedSession(context, request.params.id);
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.session.delete",
        entityType: "pizza_session",
        entityId: session.id,
        summary: `Archivierte Pizzarunde gelöscht${session.label ? `: ${session.label}` : ""}`,
        metadata: { orderCount, state: session.state }
      });
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza session delete failed");
    }
  });

  router.post("/lines", (request, response) => {
    const actor = requireUser(context, request)!;
    const scope = requireScope(context, request, response, actor);
    if (!scope) return;
    if (!canOrderInScope(context, actor, scope)) {
      response.status(403).json({ error: "pizza_nur_teilnehmer" });
      return;
    }
    const session = getActiveSession(context, scope.mainEventId);
    if (!session) {
      response.status(404).json({ error: "session_nicht_offen" });
      return;
    }
    const parsed = addLineSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    try {
      const { lineId, orderId } = addLine(context, {
        sessionId: session.id,
        userId: actor.id,
        variantId: parsed.data.variantId,
        qty: parsed.data.qty,
        customNote: parsed.data.customNote ?? null,
        extraIds: parsed.data.extraIds ?? [],
        defaultPaymentMethod: defaultPaymentMethod(offeredPaymentMethods(readSettings(context)))
      });
      broadcastEventsChanged("pizza_line_added");
      response.status(201).json({ lineId, orderId });
    } catch (error) {
      respondDomainError(error, response, "pizza addLine failed");
    }
  });

  router.patch("/lines/:lineId", (request, response) => {
    const actor = requireUser(context, request)!;
    const parsed = updateLineSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    try {
      updateLine(context, {
        lineId: request.params.lineId,
        userId: actor.id,
        qty: parsed.data.qty,
        customNote: parsed.data.customNote,
        extraIds: parsed.data.extraIds
      });
      broadcastEventsChanged("pizza_line_updated");
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza updateLine failed");
    }
  });

  router.delete("/lines/:lineId", (request, response) => {
    const actor = requireUser(context, request)!;
    try {
      deleteLine(context, request.params.lineId, actor.id);
      broadcastEventsChanged("pizza_line_deleted");
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza deleteLine failed");
    }
  });

  router.post("/orders/mine/payment-method", (request, response) => {
    const actor = requireUser(context, request)!;
    const parsed = paymentMethodSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_methode" });
      return;
    }
    const scope = requireScope(context, request, response, actor);
    if (!scope) return;
    const session = getActiveSession(context, scope.mainEventId);
    if (!session) {
      response.status(404).json({ error: "keine_session" });
      return;
    }
    try {
      setPaymentMethod(context, {
        sessionId: session.id,
        userId: actor.id,
        method: parsed.data.method,
        offered: offeredPaymentMethods(readSettings(context))
      });
      broadcastEventsChanged("pizza_payment_method");
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza payment method failed");
    }
  });

  router.post("/orders/:orderId/payment", (request, response) => {
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_methode" });
      return;
    }
    const actor = requireScopedPizzaManager(
      context,
      request,
      response,
      mainEventIdOfOrder(context, request.params.orderId)
    );
    if (!actor) return;
    try {
      markPayment(context, {
        orderId: request.params.orderId,
        method: parsed.data.method,
        adminId: actor.id
      });
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.payment.mark",
        entityType: "pizza_order",
        entityId: request.params.orderId,
        summary: `Zahlung markiert: ${parsed.data.method}`
      });
      broadcastEventsChanged("pizza_payment_marked");
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza payment failed");
    }
  });

  // --- Menüpflege (ab manager) ---------------------------------------------------------------

  router.get("/admin/menu", (request, response) => {
    if (!requirePizzaManager(context, request, response)) return;
    response.json({ items: listAllMenu(context), categories: listCategories(context), extras: listExtras(context) });
  });

  // --- Extras (ab manager) -------------------------------------------------------------------

  router.post("/admin/extras", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = extraUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const previous = parsed.data.id ? getExtraById(context, parsed.data.id) : undefined;
    try {
      const id = upsertExtra(context, parsed.data);
      tryWriteAuditLog(context, {
        actor,
        action: previous ? "pizza.menu.extra.update" : "pizza.menu.extra.create",
        entityType: "pizza_menu_extra",
        entityId: id,
        summary: `Pizza-Extra ${previous ? "geändert" : "angelegt"}: ${parsed.data.name}`,
        metadata: {
          priceCents: parsed.data.priceCents,
          previousPriceCents: previous?.priceCents ?? null,
          categoryIds: parsed.data.categoryIds
        }
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.json({ id });
    } catch (error) {
      respondDomainError(error, response, "pizza extra upsert failed");
    }
  });

  router.post("/admin/extras/:id/active", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = activeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const extra = getExtraById(context, request.params.id);
    if (!extra) {
      response.status(404).json({ error: "pizza_extra_nicht_gefunden" });
      return;
    }
    setExtraActive(context, extra.id, parsed.data.active);
    tryWriteAuditLog(context, {
      actor,
      action: parsed.data.active ? "pizza.menu.extra.activate" : "pizza.menu.extra.deactivate",
      entityType: "pizza_menu_extra",
      entityId: extra.id,
      summary: `Pizza-Extra ${parsed.data.active ? "aktiviert" : "deaktiviert"}: ${extra.name}`
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.status(204).end();
  });

  router.delete("/admin/extras/:id", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const extra = getExtraById(context, request.params.id);
    const result = removeExtra(context, request.params.id);
    if (!extra || !result) {
      response.status(404).json({ error: "pizza_extra_nicht_gefunden" });
      return;
    }
    tryWriteAuditLog(context, {
      actor,
      action: result === "deleted" ? "pizza.menu.extra.delete" : "pizza.menu.extra.deactivate",
      entityType: "pizza_menu_extra",
      entityId: extra.id,
      summary:
        result === "deleted"
          ? `Pizza-Extra gelöscht: ${extra.name}`
          : `Pizza-Extra deaktiviert (in Bestellungen verwendet): ${extra.name}`
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.json({ result });
  });

  // --- Kategorien (ab manager) ---------------------------------------------------------------

  router.post("/admin/categories", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = categoryUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const previous = parsed.data.id ? getCategoryById(context, parsed.data.id) : undefined;
    try {
      const id = upsertCategory(context, parsed.data);
      tryWriteAuditLog(context, {
        actor,
        action: previous ? "pizza.menu.category.update" : "pizza.menu.category.create",
        entityType: "pizza_menu_category",
        entityId: id,
        summary: previous
          ? `Pizza-Kategorie geändert: ${previous.name}${previous.name !== parsed.data.name ? ` → ${parsed.data.name}` : ""}`
          : `Pizza-Kategorie angelegt: ${parsed.data.name}`,
        metadata: { name: parsed.data.name, previousName: previous?.name ?? null }
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.json({ id });
    } catch (error) {
      respondDomainError(error, response, "pizza category upsert failed");
    }
  });

  router.post("/admin/categories/order", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = categoryOrderSchema.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    try {
      reorderCategories(context, parsed.data.ids);
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.menu.category.reorder",
        entityType: "pizza_menu_category",
        summary: "Pizza-Kategorien neu sortiert",
        metadata: { ids: parsed.data.ids }
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza category reorder failed");
    }
  });

  router.post("/admin/categories/:id/active", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = activeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const category = getCategoryById(context, request.params.id);
    if (!category) {
      response.status(404).json({ error: "pizza_kategorie_nicht_gefunden" });
      return;
    }
    setCategoryActive(context, category.id, parsed.data.active);
    tryWriteAuditLog(context, {
      actor,
      action: parsed.data.active ? "pizza.menu.category.activate" : "pizza.menu.category.deactivate",
      entityType: "pizza_menu_category",
      entityId: category.id,
      summary: `Pizza-Kategorie ${parsed.data.active ? "aktiviert" : "deaktiviert"}: ${category.name}`
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.status(204).end();
  });

  router.delete("/admin/categories/:id", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    try {
      const category = deleteCategory(context, request.params.id);
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.menu.category.delete",
        entityType: "pizza_menu_category",
        entityId: category.id,
        summary: `Pizza-Kategorie gelöscht: ${category.name}`
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.status(204).end();
    } catch (error) {
      respondDomainError(error, response, "pizza category delete failed");
    }
  });

  router.post("/admin/items", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = itemUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const existed = parsed.data.id ? Boolean(getItemById(context, parsed.data.id)) : false;
    try {
      const id = upsertItem(context, parsed.data);
      tryWriteAuditLog(context, {
        actor,
        action: existed ? "pizza.menu.item.update" : "pizza.menu.item.create",
        entityType: "pizza_menu_item",
        entityId: id,
        summary: `Pizza-Menüeintrag ${existed ? "geändert" : "angelegt"}: ${parsed.data.name}`,
        metadata: { categoryId: parsed.data.categoryId }
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.json({ id });
    } catch (error) {
      respondDomainError(error, response, "pizza item upsert failed");
    }
  });

  router.post("/admin/items/:id/active", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = activeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const item = getItemById(context, request.params.id);
    if (!item) {
      response.status(404).json({ error: "pizza_artikel_nicht_gefunden" });
      return;
    }
    setItemActive(context, item.id, parsed.data.active);
    tryWriteAuditLog(context, {
      actor,
      action: parsed.data.active ? "pizza.menu.item.activate" : "pizza.menu.item.deactivate",
      entityType: "pizza_menu_item",
      entityId: item.id,
      summary: `Pizza-Menüeintrag ${parsed.data.active ? "aktiviert" : "deaktiviert"}: ${item.name}`
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.status(204).end();
  });

  router.delete("/admin/items/:id", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const item = getItemById(context, request.params.id);
    const result = removeItem(context, request.params.id);
    if (!item || !result) {
      response.status(404).json({ error: "pizza_artikel_nicht_gefunden" });
      return;
    }
    tryWriteAuditLog(context, {
      actor,
      action: result === "deleted" ? "pizza.menu.item.delete" : "pizza.menu.item.deactivate",
      entityType: "pizza_menu_item",
      entityId: item.id,
      summary:
        result === "deleted"
          ? `Pizza-Menüeintrag gelöscht: ${item.name}`
          : `Pizza-Menüeintrag deaktiviert (in Bestellungen verwendet): ${item.name}`
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.json({ result });
  });

  router.post("/admin/variants", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = variantUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const previous = parsed.data.id ? getVariantById(context, parsed.data.id) : undefined;
    try {
      const id = upsertVariant(context, parsed.data);
      tryWriteAuditLog(context, {
        actor,
        action: previous ? "pizza.menu.variant.update" : "pizza.menu.variant.create",
        entityType: "pizza_menu_variant",
        entityId: id,
        summary: `Pizza-Variante ${previous ? "geändert" : "angelegt"}: ${parsed.data.sizeLabel ?? "Standard"}`,
        metadata: {
          itemId: previous?.itemId ?? parsed.data.itemId,
          priceCents: parsed.data.priceCents,
          previousPriceCents: previous?.priceCents ?? null
        }
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.json({ id });
    } catch (error) {
      respondDomainError(error, response, "pizza variant upsert failed");
    }
  });

  router.post("/admin/variants/:id/active", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = activeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_eingabe" });
      return;
    }
    const variant = getVariantById(context, request.params.id);
    if (!variant) {
      response.status(404).json({ error: "pizza_variante_nicht_gefunden" });
      return;
    }
    setVariantActive(context, variant.id, parsed.data.active);
    tryWriteAuditLog(context, {
      actor,
      action: parsed.data.active ? "pizza.menu.variant.activate" : "pizza.menu.variant.deactivate",
      entityType: "pizza_menu_variant",
      entityId: variant.id,
      summary: `Pizza-Variante ${parsed.data.active ? "aktiviert" : "deaktiviert"}: ${variant.sizeLabel ?? "Standard"}`,
      metadata: { itemId: variant.itemId }
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.status(204).end();
  });

  router.delete("/admin/variants/:id", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const variant = getVariantById(context, request.params.id);
    const result = removeVariant(context, request.params.id);
    if (!variant || !result) {
      response.status(404).json({ error: "pizza_variante_nicht_gefunden" });
      return;
    }
    tryWriteAuditLog(context, {
      actor,
      action: result === "deleted" ? "pizza.menu.variant.delete" : "pizza.menu.variant.deactivate",
      entityType: "pizza_menu_variant",
      entityId: variant.id,
      summary:
        result === "deleted"
          ? `Pizza-Variante gelöscht: ${variant.sizeLabel ?? "Standard"}`
          : `Pizza-Variante deaktiviert (in Bestellungen verwendet): ${variant.sizeLabel ?? "Standard"}`,
      metadata: { itemId: variant.itemId }
    });
    broadcastEventsChanged("pizza_menu_changed");
    response.json({ result });
  });

  router.get("/admin/menu/export", (request, response) => {
    if (!requirePizzaManager(context, request, response)) return;
    const categories = listCategories(context);
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    const items = listAllMenu(context).map((item) => ({
      id: item.id,
      number: item.number,
      name: item.name,
      ingredients: item.ingredients,
      allergens: item.allergens,
      categoryId: item.categoryId,
      category: categoryNames.get(item.categoryId) ?? null,
      active: item.active,
      sortOrder: item.sortOrder,
      variants: item.variants.map((variant) => ({
        id: variant.id,
        sizeLabel: variant.sizeLabel,
        priceCents: variant.priceCents,
        sortOrder: variant.sortOrder,
        active: variant.active
      }))
    }));
    response.json({
      categories: categories.map(({ id, name, sortOrder, active }) => ({ id, name, sortOrder, active })),
      items
    });
  });

  // --- Import/Export als YAML und CSV (ab manager) ------------------------------------------

  router.get("/admin/menu/export.yaml", (request, response) => {
    if (!requirePizzaManager(context, request, response)) return;
    sendDownload(response, "application/yaml; charset=utf-8", `pizza-menu-${today()}.yaml`, menuToYaml(buildMenuDocument(context)));
  });

  router.get("/admin/menu/export.csv", (request, response) => {
    if (!requirePizzaManager(context, request, response)) return;
    sendDownload(response, "text/csv; charset=utf-8", `pizza-menu-${today()}.csv`, menuToCsv(buildMenuDocument(context)));
  });

  router.get("/admin/menu/extras-export.csv", (request, response) => {
    if (!requirePizzaManager(context, request, response)) return;
    sendDownload(response, "text/csv; charset=utf-8", `pizza-extras-${today()}.csv`, extrasToCsv(buildMenuDocument(context)));
  });

  /** Vorschau: zählt neue/geänderte/unveränderte Einträge, meldet Fehler mit Zeilennummer, schreibt nichts. */
  router.post("/admin/menu/transfer/preview", (request, response) => {
    if (!requirePizzaManager(context, request, response)) return;
    const body = parseMenuTransferBody(request.body, response);
    if (!body) return;
    response.json(previewMenuTransfer(context, body.format, body.content));
  });

  router.post("/admin/menu/transfer/apply", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const body = parseMenuTransferBody(request.body, response);
    if (!body) return;
    try {
      const { outcome, result } = applyMenuTransfer(context, body.format, body.content, {
        expectedVersion: body.expectedVersion,
        confirmRemovals: body.confirmRemovals
      });
      if (outcome === "errors") {
        response.status(400).json({ error: "pizza_import_fehlerhaft", result });
        return;
      }
      if (outcome === "stale") {
        // Menü hat sich seit der Vorschau geändert: nichts übernehmen, neue Vorschau mitliefern.
        response.status(409).json({ error: "pizza_menu_geaendert", result });
        return;
      }
      if (outcome === "confirm") {
        response.status(409).json({ error: "pizza_import_bestaetigung_noetig", result });
        return;
      }
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.menu.import",
        entityType: "pizza_menu",
        summary: `Pizza-Menü importiert (${body.format === "yaml" ? "YAML" : body.format === "csv" ? "CSV" : "Extras-CSV"})`,
        metadata: { format: body.format, counts: result.counts }
      });
      broadcastEventsChanged("pizza_menu_changed");
      response.json(result);
    } catch (error) {
      respondDomainError(error, response, "pizza menu transfer failed");
    }
  });

  router.put("/admin/menu/import", (request, response) => {
    const actor = requirePizzaManager(context, request, response);
    if (!actor) return;
    const parsed = menuImportSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "ungueltiges_menu",
        details: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    const seenItemIds = new Set<string>();
    const seenVariantIds = new Set<string>();

    try {
      const tx = context.sqlite.transaction(() => {
        for (const categoryInput of parsed.data.categories ?? []) {
          const byId = categoryInput.id ? getCategoryById(context, categoryInput.id) : undefined;
          const target = byId ?? findCategoryByName(context, categoryInput.name);
          upsertCategory(context, { ...categoryInput, id: target?.id });
        }
        const resolveCategoryId = (itemInput: { categoryId?: string; category?: string }) => {
          if (itemInput.categoryId && getCategoryById(context, itemInput.categoryId)) return itemInput.categoryId;
          const name = itemInput.category ?? "";
          return findCategoryByName(context, name)?.id ?? upsertCategory(context, { name });
        };
        for (const itemInput of parsed.data.items) {
          const itemId = upsertItem(context, {
            id: itemInput.id,
            number: itemInput.number ?? null,
            name: itemInput.name,
            ingredients: itemInput.ingredients ?? null,
            allergens: itemInput.allergens ?? null,
            categoryId: resolveCategoryId(itemInput),
            active: itemInput.active ?? true,
            sortOrder: itemInput.sortOrder ?? 0
          });
          seenItemIds.add(itemId);
          for (const variantInput of itemInput.variants) {
            const variantId = upsertVariant(context, {
              id: variantInput.id,
              itemId,
              sizeLabel: variantInput.sizeLabel,
              priceCents: variantInput.priceCents,
              sortOrder: variantInput.sortOrder ?? 0,
              active: variantInput.active ?? true
            });
            seenVariantIds.add(variantId);
          }
        }

        const allDbItems = context.db.select().from(pizzaMenuItems).all();
        let deactivated = 0;
        for (const dbItem of allDbItems) {
          if (!seenItemIds.has(dbItem.id) && dbItem.active) {
            setItemActive(context, dbItem.id, false);
            deactivated += 1;
          }
        }
        const allDbVariants = context.db.select().from(pizzaMenuVariants).all();
        let variantsRemoved = 0;
        let variantsDeactivated = 0;
        for (const dbVariant of allDbVariants) {
          if (seenVariantIds.has(dbVariant.id)) continue;
          // Referenzierte Varianten (Bestellhistorie) werden deaktiviert statt gelöscht.
          const result = removeVariant(context, dbVariant.id);
          if (result === "deleted") variantsRemoved += 1;
          if (result === "deactivated" && dbVariant.active) variantsDeactivated += 1;
        }

        return { deactivated, variantsRemoved, variantsDeactivated };
      });

      const stats = tx();
      tryWriteAuditLog(context, {
        actor,
        action: "pizza.menu.import",
        entityType: "pizza_menu",
        summary: `Pizza-Menü importiert (${parsed.data.items.length} Einträge)`,
        metadata: {
          itemCount: parsed.data.items.length,
          deactivated: stats.deactivated,
          variantsRemoved: stats.variantsRemoved,
          variantsDeactivated: stats.variantsDeactivated
        }
      });
      broadcastEventsChanged("pizza_menu_changed");

      response.json({
        ok: true,
        itemCount: parsed.data.items.length,
        deactivated: stats.deactivated,
        variantsRemoved: stats.variantsRemoved,
        variantsDeactivated: stats.variantsDeactivated
      });
    } catch (error) {
      if (handleDomainError(error, response)) return;
      console.error("[Matchdesk] pizza menu import failed", error);
      response.status(500).json({ error: "import_fehler" });
    }
  });

  // --- Druck (ab manager) --------------------------------------------------------------------

  router.get("/print/pizzeria.pdf", async (request, response) => {
    const session = resolvePrintSession(context, request, response);
    if (!session) return;
    const orders = listOrdersForSession(context, session.id);
    const settings = readSettings(context);
    const menu = listAllMenu(context);
    const itemsById = new Map(menu.map((item) => [item.id, item]));

    type Aggregate = {
      number: string | null;
      name: string;
      sizeLabel: string | null;
      extras: string[];
      qty: number;
      customNotes: string[];
      sortKey: string;
    };

    const aggregateMap = new Map<string, Aggregate>();
    for (const order of orders) {
      for (const line of order.lines) {
        const variant = getVariantById(context, line.variantId);
        if (!variant) continue;
        const item = itemsById.get(variant.itemId);
        if (!item) continue;
        // Gleiche Variante mit anderen Extras ist für die Pizzeria eine eigene Zeile.
        const extraNames = line.extras.map((extra) => extra.name).sort((a, b) => a.localeCompare(b, "de"));
        const key = `${item.id}:${variant.id}:${line.extras.map((extra) => extra.extraId).sort().join(",")}`;
        const existing = aggregateMap.get(key);
        const note = line.customNote;
        if (existing) {
          existing.qty += line.qty;
          if (note) existing.customNotes.push(`${line.qty}× ${note}`);
        } else {
          aggregateMap.set(key, {
            number: item.number,
            name: item.name,
            sizeLabel: variant.sizeLabel,
            extras: extraNames,
            qty: line.qty,
            customNotes: note ? [`${line.qty}× ${note}`] : [],
            sortKey: `${item.number ?? "zzz"}:${variant.sortOrder}:${extraNames.join(",")}`
          });
        }
      }
    }

    const rows = Array.from(aggregateMap.values())
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map((row) => ({
        number: row.number,
        name: row.name,
        sizeLabel: row.sizeLabel,
        extras: row.extras,
        qty: row.qty,
        customNote: row.customNotes.length > 0 ? row.customNotes.join("; ") : null
      }));

    try {
      const buffer = await buildPizzeriaPdf({
        eventTitle: session.label ?? "Pizzabestellung",
        printedAt: new Date(),
        rows
      });
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="pizzeria-${session.id}.pdf"`
      );
      response.send(buffer);
    } catch (error) {
      console.error("[Matchdesk] pizzeria pdf failed", error);
      response.status(500).json({ error: "pdf_fehler" });
    }
  });

  router.get("/print/kassenliste.pdf", async (request, response) => {
    const session = resolvePrintSession(context, request, response);
    if (!session) return;
    const orders = listOrdersForSession(context, session.id);
    const settings = readSettings(context);
    const labels = buildLineLabels(listAllMenu(context));
    const usersById = loadUsers(
      context,
      orders.map((order) => order.userId)
    );
    const offered = offeredPaymentMethods(settings);

    const guests = orders
      .map((order) => {
        const user = usersById.get(order.userId);
        const totalCents = order.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
        return {
          username: user?.username ?? "[gelöschter user]",
          displayName: user?.displayName ?? null,
          totalCents,
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
          lines: order.lines.map((line) => {
            const label = labelFor(labels, line.variantId);
            return {
              number: label.itemNumber,
              name: label.itemName,
              sizeLabel: label.sizeLabel,
              qty: line.qty,
              priceCentsSnapshot: line.priceCentsSnapshot,
              extras: line.extras.map((extra) => ({ name: extra.name, priceCentsSnapshot: extra.priceCentsSnapshot })),
              customNote: line.customNote
            };
          })
        };
      })
      .sort((a, b) => (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username));

    // Empfänger auch drucken, wenn eine Bestellung die Bezahlart gewählt hat, die heute nicht mehr
    // angeboten wird (archivierte Runden behalten ihre Wahl; LAN-Prüfung K1).
    const showPaypal = offered.includes("paypal") || guests.some((guest) => guest.paymentMethod === "paypal");
    const showCash = offered.includes("cash") || guests.some((guest) => guest.paymentMethod === "cash");

    try {
      const buffer = await buildKassenlistePdf({
        eventTitle: session.label ?? "Pizzabestellung",
        printedAt: new Date(),
        paypalName: showPaypal ? settings.pizzaPaypalName || null : null,
        paypalHandle: showPaypal ? settings.pizzaPaypalHandle || null : null,
        cashRecipient: showCash ? settings.pizzaCashRecipient || null : null,
        guests
      });
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="kassenliste-${session.id}.pdf"`
      );
      response.send(buffer);
    } catch (error) {
      console.error("[Matchdesk] kassenliste pdf failed", error);
      response.status(500).json({ error: "pdf_fehler" });
    }
  });

  return router;
}
