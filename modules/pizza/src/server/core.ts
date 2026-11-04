import type { Request, Response } from "express";
import type { ModuleContext, ModuleUser, PushPayload } from "@matchdesk/module-sdk";
import type { DatabaseContext } from "./db/client";
import type { MatchdeskSettings } from "./settings";
import type { PizzaSettings } from "../settings";

/*
 * Brücke zum Kern: Bis Matchdesk 0.17 war Pizza fest eingebaut und rief Kern-Funktionen direkt auf.
 * Diese Datei bietet dieselben Namen an, leitet aber alles über `ctx` aus dem Modul-SDK. So bleibt
 * der übernommene Code (http/pizza-routes.ts, domain/pizza/*) fast unverändert.
 */

let current: ModuleContext | null = null;

export function bindCore(ctx: ModuleContext) {
  current = ctx;
}

function ctx(): ModuleContext {
  if (!current) throw new Error("Pizza-Modul ist nicht gestartet");
  return current;
}

export type PizzaActor = ModuleUser;

export function requireUser(_context: DatabaseContext, request: Request): PizzaActor | undefined {
  return ctx().currentUser(request);
}

/** Schreibschutz wie im Kern: CSRF bei Sitzungen, Schreibrecht bei API-Tokens. */
export function requireWrite(request: Request, response: Response) {
  return ctx().requireWrite(request, response);
}

export function can(
  _context: DatabaseContext,
  actor: { id: string; role: string } | null | undefined,
  key: string,
  options: { mainEventId?: string | null } = {}
) {
  return ctx().can(actor, key, options);
}

export function canManagePizza(context: DatabaseContext, actor: { id: string; role: string }) {
  return can(context, actor, "pizza.manage");
}

export function scopedEventIds(_context: DatabaseContext, actor: { id: string; role: string }, key: string) {
  return ctx().scopedEventIds(actor, key);
}

export function currentMainEventIdOf(_context: DatabaseContext, actor: { id: string }) {
  return ctx().events.currentIdOf(actor);
}

export function getMainEvent(_context: DatabaseContext, id: string) {
  return ctx().events.get(id) ?? undefined;
}

export function canSeeMainEvent(_context: DatabaseContext, actor: { id: string; role: string }, event: { id: string }) {
  return ctx().events.canSee(actor, event.id);
}

export function participantStatus(mainEventId: string, userId: string) {
  return ctx().events.participantStatus(mainEventId, userId);
}

export function tryWriteAuditLog(
  _context: DatabaseContext,
  entry: {
    actor?: { id: string; username: string } | null;
    action: string;
    entityType?: string;
    entityId?: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    ctx().audit({
      actor: entry.actor ? { id: entry.actor.id, username: entry.actor.username } : null,
      // Der Kern stellt die Modul-ID voran („pizza.“).
      action: entry.action.replace(/^pizza\./, ""),
      entityId: entry.entityId ?? null,
      summary: entry.summary,
      metadata: { ...(entry.metadata ?? {}), ...(entry.entityType ? { entityType: entry.entityType } : {}) }
    });
  } catch (error) {
    ctx().log.error("Audit-Log", error);
  }
}

/** Live-Aktualisierung: Clients laden bei `changed` neu (früher `events_changed` mit Grund `pizza_…`). */
export function broadcastEventsChanged(reason: string) {
  ctx().realtime.broadcast("changed", { reason });
}

export function sendPushToEnabledUsers(_context: DatabaseContext, payload: PushPayload) {
  return ctx().push.toAll(payload);
}

export function sendPushToMainEventParticipants(_context: DatabaseContext, mainEventId: string, payload: PushPayload) {
  return ctx().push.toEventParticipants(mainEventId, payload);
}

function pizzaSettings(): PizzaSettings {
  return ctx().settings.get() as PizzaSettings;
}

/** Einstellungen in der Form, die der übernommene Code erwartet. */
export function readSettings(_context: DatabaseContext): MatchdeskSettings {
  const settings = pizzaSettings();
  return {
    pizzaPaypalHandle: settings.paypalHandle,
    pizzaPaypalName: settings.paypalName,
    pizzaCashRecipient: settings.cashRecipient,
    pizzaPaymentMethods: settings.paymentMethods
  };
}

export function writeSettings(
  _context: DatabaseContext,
  values: Partial<MatchdeskSettings>,
  actor: { id: string; username: string; role: string }
) {
  const next: Partial<PizzaSettings> = {};
  if (values.pizzaPaymentMethods) next.paymentMethods = values.pizzaPaymentMethods;
  if (values.pizzaPaypalHandle !== undefined) next.paypalHandle = values.pizzaPaypalHandle;
  if (values.pizzaPaypalName !== undefined) next.paypalName = values.pizzaPaypalName;
  if (values.pizzaCashRecipient !== undefined) next.cashRecipient = values.pizzaCashRecipient;
  ctx().settings.set(next, actor);
}
