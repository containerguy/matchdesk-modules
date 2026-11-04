import { randomUUID } from "node:crypto";
import type { ModuleContext } from "@matchdesk/module-sdk";
import type { HalloSettings } from "./settings";

type NoteRow = { id: string; text: string; created_at: string; main_event_id: string | null; username: string | null };

export function register(ctx: ModuleContext) {
  const settings = () => ctx.settings.get() as HalloSettings;

  ctx.router.get("/notes", (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return void response.status(401).json({ error: "nicht_angemeldet" });
    if (!ctx.can(user, "hallo.view")) return void response.status(403).json({ error: "recht_fehlt" });
    const notes = ctx.db
      .prepare(
        `SELECT n.id, n.text, n.created_at, n.main_event_id, u.username
         FROM hallo_notes n LEFT JOIN users u ON u.id = n.user_id
         ORDER BY n.created_at DESC LIMIT ?`
      )
      .all(settings().maxNotes) as NoteRow[];
    response.json({
      greeting: settings().greeting,
      canPost: ctx.can(user, "hallo.post"),
      canManage: ctx.can(user, "hallo.manage"),
      notes: notes.map((note) => ({
        id: note.id,
        text: note.text,
        createdAt: note.created_at,
        mainEventId: note.main_event_id,
        author: note.username
      }))
    });
  });

  ctx.router.post("/notes", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const mainEventId = typeof request.body?.mainEventId === "string" ? request.body.mainEventId : null;
    if (!ctx.can(user, "hallo.post", { mainEventId })) return void response.status(403).json({ error: "recht_fehlt" });
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text || text.length > 500) return void response.status(400).json({ error: "text_ungueltig" });
    const id = randomUUID();
    ctx.db
      .prepare("INSERT INTO hallo_notes (id, user_id, main_event_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, user.id, mainEventId, text, new Date().toISOString());
    ctx.audit({ actor: user, action: "note_created", summary: `Notiz angepinnt`, entityId: id });
    ctx.realtime.broadcast("notes_changed");
    if (settings().notifyOnPost) {
      const readers = (ctx.db.prepare("SELECT id, role FROM users WHERE deleted_at IS NULL").all() as Array<{ id: string; role: string }>)
        .filter((reader) => reader.id !== user.id && ctx.can(reader, "hallo.view"))
        .map((reader) => reader.id);
      void ctx.push.toUsers(readers, { title: "Neue Notiz", body: text.slice(0, 120), url: "/#m/hallo" });
    }
    response.status(201).json({ id });
  });

  ctx.router.delete("/notes/:id", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const note = ctx.db.prepare("SELECT user_id FROM hallo_notes WHERE id = ?").get(request.params.id) as
      | { user_id: string | null }
      | undefined;
    if (!note) return void response.status(404).json({ error: "nicht_gefunden" });
    if (note.user_id !== user.id && !ctx.can(user, "hallo.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    ctx.db.prepare("DELETE FROM hallo_notes WHERE id = ?").run(request.params.id);
    ctx.audit({ actor: user, action: "note_deleted", summary: "Notiz entfernt", entityId: request.params.id });
    ctx.realtime.broadcast("notes_changed");
    response.status(204).end();
  });

  ctx.router.get("/admin/stats", (request, response) => {
    const user = ctx.currentUser(request);
    if (!ctx.can(user, "hallo.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    const row = ctx.db.prepare("SELECT COUNT(*) AS count FROM hallo_notes").get() as { count: number };
    response.json({ count: row.count });
  });

  ctx.router.delete("/admin/notes", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    if (!ctx.can(user, "hallo.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    const result = ctx.db.prepare("DELETE FROM hallo_notes").run();
    ctx.audit({ actor: user, action: "notes_cleared", summary: `${result.changes} Notizen gelöscht` });
    ctx.realtime.broadcast("notes_changed");
    response.status(204).end();
  });

  ctx.log.info("Modul Hallo gestartet");
}
