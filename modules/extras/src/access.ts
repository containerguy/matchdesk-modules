import type { Request, Response } from "express";
import type { ModuleContext, ModuleUser } from "@matchdesk/module-sdk";

export type EventRow = { id: string; name: string; status: string; visibility?: string };

/**
 * Zugriff auf Events wie im Kern: private Events sehen nur Eingeladene und wer Events verwalten darf.
 * Ältere Kerne (oder die Testhilfe) ohne `visibility`/`main_event_invites`/`main_event_participants`
 * werden erkannt; dann ist alles öffentlich und Teilnehmer sind unbekannt.
 */
export function createAccess(ctx: ModuleContext) {
  const columns = new Set((ctx.db.prepare("PRAGMA table_info(main_events)").all() as Array<{ name: string }>).map((row) => row.name));
  const hasTable = (name: string) => Boolean(ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const hasVisibility = columns.has("visibility");
  const hasInvites = hasTable("main_event_invites");
  const hasParticipants = hasTable("main_event_participants");
  const select = `SELECT id, name, status${hasVisibility ? ", visibility" : ""} FROM main_events`;

  function eventOf(id: string) {
    return ctx.db.prepare(`${select} WHERE id = ?`).get(id) as EventRow | undefined;
  }

  function canSee(user: ModuleUser, event: EventRow) {
    if (event.visibility !== "private") return true;
    if (ctx.can(user, "main_events.manage", { mainEventId: event.id })) return true;
    if (!hasInvites) return false;
    return Boolean(ctx.db.prepare("SELECT 1 FROM main_event_invites WHERE main_event_id = ? AND user_id = ?").get(event.id, user.id));
  }

  const canManage = (user: ModuleUser, eventId: string) => ctx.can(user, "extras.manage", { mainEventId: eventId });

  function visibleEvents(user: ModuleUser) {
    return (ctx.db.prepare(`${select} ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, name`).all() as EventRow[]).filter(
      (event) => canSee(user, event)
    );
  }

  /** Zugesagte Teilnehmer (für den Unkostenbeitrag); null, wenn der Kern keine Teilnehmer kennt. */
  function joinedUserIds(eventId: string): string[] | null {
    if (!hasParticipants) return null;
    return (
      ctx.db.prepare("SELECT user_id FROM main_event_participants WHERE main_event_id = ? AND status = 'joined'").all(eventId) as Array<{
        user_id: string;
      }>
    ).map((row) => row.user_id);
  }

  /**
   * Gemeinsamer Einstieg jeder Route unter /events/:eventId: angemeldet, Recht extras.view, Event sichtbar.
   * `write` prüft zusätzlich CSRF/Schreibzugriff.
   */
  function enter(request: Request, response: Response, eventId: string, options: { write?: boolean } = {}) {
    if (options.write && !ctx.requireWrite(request, response)) return null;
    const user = ctx.currentUser(request);
    if (!user) {
      response.status(401).json({ error: "nicht_angemeldet" });
      return null;
    }
    if (!ctx.can(user, "extras.view")) {
      response.status(403).json({ error: "recht_fehlt" });
      return null;
    }
    const event = eventOf(eventId);
    if (!event || !canSee(user, event)) {
      response.status(404).json({ error: "event_nicht_gefunden" });
      return null;
    }
    return { user, event, manage: canManage(user, event.id), ended: event.status === "ended" };
  }

  return { eventOf, canSee, canManage, visibleEvents, joinedUserIds, enter };
}

export type Access = ReturnType<typeof createAccess>;
