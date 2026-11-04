import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { z } from "zod";
import type { ModuleContext, ModuleUser } from "@matchdesk/module-sdk";
import type { PollsSettings } from "./settings";

/*
 * Abstimmungen: global oder für ein Event. Arten:
 * - game, food, other: Auswahl (eine oder mehrere Optionen)
 * - date: Terminfindung, je Termin ja / vielleicht / nein
 */

export const POLL_KINDS = ["game", "date", "food", "other"] as const;
type Kind = (typeof POLL_KINDS)[number];
type VoteValue = "yes" | "maybe" | "no";

type PollRow = {
  id: string;
  main_event_id: string | null;
  kind: Kind;
  title: string;
  description: string | null;
  multiple: number;
  allow_suggestions: number;
  anonymous: number;
  closes_at: string | null;
  closed_at: string | null;
  created_by: string | null;
  created_at: string;
};
type OptionRow = { id: string; poll_id: string; label: string; starts_at: string | null; position: number; created_by: string | null };
type VoteRow = { option_id: string; poll_id: string; user_id: string; value: VoteValue; username: string; display_name: string | null };
type EventRow = { id: string; name: string; status: string; visibility?: string };

const optionInput = z.object({
  label: z.string().trim().min(1).max(120),
  startsAt: z.string().datetime({ offset: true }).nullable().optional()
});

const pollInput = z.object({
  kind: z.enum(POLL_KINDS),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  mainEventId: z.string().min(1).max(64).nullable().optional(),
  multiple: z.boolean().optional(),
  allowSuggestions: z.boolean().optional(),
  anonymous: z.boolean().optional(),
  closesAt: z.string().datetime({ offset: true }).nullable().optional(),
  options: z.array(optionInput).max(100).default([])
});

const pollUpdate = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  allowSuggestions: z.boolean().optional(),
  closesAt: z.string().datetime({ offset: true }).nullable().optional(),
  closed: z.boolean().optional()
});

const voteInput = z.object({
  votes: z.array(z.object({ optionId: z.string().min(1).max(64), value: z.enum(["yes", "maybe", "no"]).default("yes") })).max(100)
});

/** Zeitpunkte einheitlich in UTC speichern, damit Vergleiche als Text stimmen. */
const utc = (value: string | null | undefined) => (value ? new Date(value).toISOString() : null);

export function register(ctx: ModuleContext) {
  const settings = () => ctx.settings.get() as PollsSettings;
  const now = () => new Date().toISOString();

  // Ältere Kerne (oder die Testhilfe) kennen keine privaten Events; dann ist alles öffentlich.
  const eventColumns = new Set((ctx.db.prepare("PRAGMA table_info(main_events)").all() as Array<{ name: string }>).map((row) => row.name));
  const hasVisibility = eventColumns.has("visibility");
  const hasInvites = Boolean(ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'main_event_invites'").get());

  function eventOf(id: string) {
    return ctx.db
      .prepare(`SELECT id, name, status${hasVisibility ? ", visibility" : ""} FROM main_events WHERE id = ?`)
      .get(id) as EventRow | undefined;
  }

  /** Wie im Kern: private Events sehen Eingeladene und wer Events verwalten darf. */
  function canSeeEvent(user: ModuleUser, event: EventRow) {
    if (event.visibility !== "private") return true;
    if (ctx.can(user, "main_events.manage", { mainEventId: event.id })) return true;
    if (!hasInvites) return false;
    return Boolean(ctx.db.prepare("SELECT 1 FROM main_event_invites WHERE main_event_id = ? AND user_id = ?").get(event.id, user.id));
  }

  const canManage = (user: ModuleUser, poll: Pick<PollRow, "main_event_id">) => ctx.can(user, "polls.manage", { mainEventId: poll.main_event_id });
  const canVote = (user: ModuleUser, poll: Pick<PollRow, "main_event_id">) => ctx.can(user, "polls.vote", { mainEventId: poll.main_event_id });

  function isOpen(poll: PollRow, event: EventRow | undefined) {
    if (poll.closed_at) return false;
    if (poll.closes_at && poll.closes_at <= now()) return false;
    // Mit dem Event endet auch die Abstimmung.
    return !(event && event.status === "ended");
  }

  function fail(response: Response, status: number, error: string) {
    response.status(status).json({ error });
  }

  /** Abstimmung laden und Sichtbarkeit prüfen; schickt sonst 404. */
  function loadVisible(user: ModuleUser, id: string, response: Response) {
    const poll = ctx.db.prepare("SELECT * FROM polls_polls WHERE id = ?").get(id) as PollRow | undefined;
    const event = poll?.main_event_id ? eventOf(poll.main_event_id) : undefined;
    if (!poll || (event && !canSeeEvent(user, event))) {
      fail(response, 404, "abstimmung_nicht_gefunden");
      return null;
    }
    return { poll, event };
  }

  function serialize(user: ModuleUser, poll: PollRow, event: EventRow | undefined) {
    const options = ctx.db.prepare("SELECT * FROM polls_options WHERE poll_id = ? ORDER BY position, created_at").all(poll.id) as OptionRow[];
    const votes = ctx.db
      .prepare(
        `SELECT v.option_id, v.poll_id, v.user_id, v.value, u.username, u.display_name
         FROM polls_votes v JOIN users u ON u.id = v.user_id
         WHERE v.poll_id = ? AND u.deleted_at IS NULL`
      )
      .all(poll.id) as VoteRow[];
    const manage = canManage(user, poll);
    const showNames = !poll.anonymous || manage;
    const voters = new Set(votes.filter((vote) => vote.value !== "no").map((vote) => vote.user_id));
    return {
      id: poll.id,
      kind: poll.kind,
      title: poll.title,
      description: poll.description,
      mainEventId: poll.main_event_id,
      mainEventName: event?.name ?? null,
      multiple: Boolean(poll.multiple),
      allowSuggestions: Boolean(poll.allow_suggestions),
      anonymous: Boolean(poll.anonymous),
      closesAt: poll.closes_at,
      closedAt: poll.closed_at,
      open: isOpen(poll, event),
      createdAt: poll.created_at,
      canManage: manage,
      canVote: canVote(user, poll),
      voterCount: voters.size,
      options: options.map((option) => {
        const forOption = votes.filter((vote) => vote.option_id === option.id);
        const count = (value: VoteValue) => forOption.filter((vote) => vote.value === value).length;
        return {
          id: option.id,
          label: option.label,
          startsAt: option.starts_at,
          suggested: Boolean(option.created_by && option.created_by !== poll.created_by),
          yes: count("yes"),
          maybe: count("maybe"),
          no: count("no"),
          mine: forOption.find((vote) => vote.user_id === user.id)?.value ?? null,
          voters: showNames
            ? forOption.map((vote) => ({ username: vote.username, displayName: vote.display_name, value: vote.value }))
            : []
        };
      })
    };
  }

  function insertOption(pollId: string, option: z.infer<typeof optionInput>, userId: string, position: number) {
    const id = randomUUID();
    ctx.db
      .prepare("INSERT INTO polls_options (id, poll_id, label, starts_at, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, pollId, option.label, utc(option.startsAt), position, userId, now());
    return id;
  }

  // Ohne ID: auch private Abstimmungen sollen nichts verraten. Die Seite lädt neu.
  const changed = (_pollId: string) => ctx.realtime.broadcast("polls_changed");

  // ---------- Lesen ----------

  ctx.router.get("/polls", (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return fail(response, 401, "nicht_angemeldet");
    if (!ctx.can(user, "polls.view")) return fail(response, 403, "recht_fehlt");
    const filter = typeof request.query.mainEventId === "string" ? request.query.mainEventId : null;
    const rows = (
      filter === "global"
        ? ctx.db.prepare("SELECT * FROM polls_polls WHERE main_event_id IS NULL ORDER BY created_at DESC").all()
        : filter
          ? ctx.db.prepare("SELECT * FROM polls_polls WHERE main_event_id = ? ORDER BY created_at DESC").all(filter)
          : ctx.db.prepare("SELECT * FROM polls_polls ORDER BY created_at DESC LIMIT 200").all()
    ) as PollRow[];
    const events = new Map<string, EventRow | undefined>();
    const polls = rows
      .map((poll) => {
        if (poll.main_event_id && !events.has(poll.main_event_id)) events.set(poll.main_event_id, eventOf(poll.main_event_id));
        const event = poll.main_event_id ? events.get(poll.main_event_id) : undefined;
        return { poll, event };
      })
      .filter(({ event }) => !event || canSeeEvent(user, event))
      .map(({ poll, event }) => serialize(user, poll, event));
    response.json({ polls });
  });

  /** Events für Filter und Formular: nicht beendet und sichtbar; `manageable` = darf dort Abstimmungen anlegen. */
  ctx.router.get("/events", (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return fail(response, 401, "nicht_angemeldet");
    if (!ctx.can(user, "polls.view")) return fail(response, 403, "recht_fehlt");
    const events = ctx.db
      .prepare(`SELECT id, name, status${hasVisibility ? ", visibility" : ""} FROM main_events WHERE status != 'ended' ORDER BY name`)
      .all() as EventRow[];
    response.json({
      canManageGlobal: ctx.can(user, "polls.manage"),
      events: events
        .filter((event) => canSeeEvent(user, event))
        .map((event) => ({ id: event.id, name: event.name, status: event.status, manageable: ctx.can(user, "polls.manage", { mainEventId: event.id }) }))
    });
  });

  ctx.router.get("/polls/:id", (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return fail(response, 401, "nicht_angemeldet");
    if (!ctx.can(user, "polls.view")) return fail(response, 403, "recht_fehlt");
    const loaded = loadVisible(user, String(request.params.id), response);
    if (loaded) response.json(serialize(user, loaded.poll, loaded.event));
  });

  // ---------- Verwalten ----------

  ctx.router.post("/polls", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const parsed = pollInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "abstimmung_ungueltig");
    const input = parsed.data;
    const mainEventId = input.mainEventId ?? null;
    if (!ctx.can(user, "polls.manage", { mainEventId })) return fail(response, 403, "recht_fehlt");
    let event: EventRow | undefined;
    if (mainEventId) {
      event = eventOf(mainEventId);
      if (!event || !canSeeEvent(user, event)) return fail(response, 400, "event_nicht_gefunden");
      if (event.status === "ended") return fail(response, 409, "event_beendet");
    }
    if (input.options.length > settings().maxOptions) return fail(response, 400, "zu_viele_optionen");
    if (input.kind === "date" && input.options.some((option) => !option.startsAt)) return fail(response, 400, "termin_fehlt");
    if (input.options.length < 2 && !input.allowSuggestions) return fail(response, 400, "zu_wenige_optionen");

    const id = randomUUID();
    const timestamp = now();
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO polls_polls (id, main_event_id, kind, title, description, multiple, allow_suggestions, anonymous, closes_at, closed_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run(
          id,
          mainEventId,
          input.kind,
          input.title,
          input.description || null,
          // Termine: jede Option einzeln ja/vielleicht/nein, also immer mehrere.
          input.kind === "date" || input.multiple ? 1 : 0,
          input.allowSuggestions ? 1 : 0,
          input.anonymous ? 1 : 0,
          utc(input.closesAt),
          user.id,
          timestamp,
          timestamp
        );
      input.options.forEach((option, index) => insertOption(id, option, user.id, index));
    })();
    ctx.audit({ actor: user, action: "created", summary: `Abstimmung „${input.title}“ angelegt`, entityId: id, metadata: { mainEventId } });
    changed(id);

    if (settings().notifyOnCreate) {
      const readers = (ctx.db.prepare("SELECT id, role FROM users WHERE deleted_at IS NULL").all() as Array<{ id: string; role: string }>)
        .filter((reader) => reader.id !== user.id && ctx.can(reader, "polls.view"))
        .filter((reader) => !event || canSeeEvent(reader as ModuleUser, event))
        .map((reader) => reader.id);
      if (readers.length > 0) {
        void ctx.push
          .toUsers(readers, {
            title: event ? `${event.name}: Neue Abstimmung` : "Neue Abstimmung",
            body: input.title,
            url: `/#m/polls`
          })
          .catch((error) => ctx.log.warn("Push zur Abstimmung fehlgeschlagen", error));
      }
    }
    const created = ctx.db.prepare("SELECT * FROM polls_polls WHERE id = ?").get(id) as PollRow;
    response.status(201).json(serialize(user, created, event));
  });

  ctx.router.patch("/polls/:id", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const loaded = loadVisible(user, String(request.params.id), response);
    if (!loaded) return;
    const { poll, event } = loaded;
    if (!canManage(user, poll)) return fail(response, 403, "recht_fehlt");
    const parsed = pollUpdate.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "abstimmung_ungueltig");
    const input = parsed.data;
    if (input.closed === false && event?.status === "ended") return fail(response, 409, "event_beendet");
    ctx.db
      .prepare(
        "UPDATE polls_polls SET title = ?, description = ?, allow_suggestions = ?, closes_at = ?, closed_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        input.title ?? poll.title,
        input.description === undefined ? poll.description : input.description || null,
        input.allowSuggestions === undefined ? poll.allow_suggestions : input.allowSuggestions ? 1 : 0,
        input.closesAt === undefined ? poll.closes_at : utc(input.closesAt),
        input.closed === undefined ? poll.closed_at : input.closed ? (poll.closed_at ?? now()) : null,
        now(),
        poll.id
      );
    ctx.audit({ actor: user, action: "updated", summary: `Abstimmung „${input.title ?? poll.title}“ geändert`, entityId: poll.id, metadata: input });
    changed(poll.id);
    const updated = ctx.db.prepare("SELECT * FROM polls_polls WHERE id = ?").get(poll.id) as PollRow;
    response.json(serialize(user, updated, event));
  });

  ctx.router.delete("/polls/:id", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const loaded = loadVisible(user, String(request.params.id), response);
    if (!loaded) return;
    if (!canManage(user, loaded.poll)) return fail(response, 403, "recht_fehlt");
    ctx.db.prepare("DELETE FROM polls_polls WHERE id = ?").run(loaded.poll.id);
    ctx.audit({ actor: user, action: "deleted", summary: `Abstimmung „${loaded.poll.title}“ gelöscht`, entityId: loaded.poll.id });
    changed(loaded.poll.id);
    response.status(204).end();
  });

  // ---------- Optionen ----------

  ctx.router.post("/polls/:id/options", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const loaded = loadVisible(user, String(request.params.id), response);
    if (!loaded) return;
    const { poll, event } = loaded;
    const manage = canManage(user, poll);
    if (!manage && !(poll.allow_suggestions && canVote(user, poll))) return fail(response, 403, "recht_fehlt");
    if (!isOpen(poll, event)) return fail(response, 409, "abstimmung_geschlossen");
    const parsed = optionInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "option_ungueltig");
    if (poll.kind === "date" && !parsed.data.startsAt) return fail(response, 400, "termin_fehlt");
    const existing = ctx.db.prepare("SELECT label FROM polls_options WHERE poll_id = ?").all(poll.id) as Array<{ label: string }>;
    if (existing.length >= settings().maxOptions) return fail(response, 409, "zu_viele_optionen");
    if (poll.kind !== "date" && existing.some((option) => option.label.toLowerCase() === parsed.data.label.toLowerCase())) {
      return fail(response, 409, "option_existiert");
    }
    insertOption(poll.id, parsed.data, user.id, existing.length);
    changed(poll.id);
    response.status(201).json(serialize(user, poll, event));
  });

  ctx.router.delete("/polls/:id/options/:optionId", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const loaded = loadVisible(user, String(request.params.id), response);
    if (!loaded) return;
    const option = ctx.db
      .prepare("SELECT * FROM polls_options WHERE id = ? AND poll_id = ?")
      .get(String(request.params.optionId), loaded.poll.id) as OptionRow | undefined;
    if (!option) return fail(response, 404, "option_nicht_gefunden");
    // Eigene Vorschläge darf man zurückziehen, solange niemand dafür gestimmt hat.
    const ownUnvoted =
      option.created_by === user.id && !ctx.db.prepare("SELECT 1 FROM polls_votes WHERE option_id = ? AND user_id != ?").get(option.id, user.id);
    if (!canManage(user, loaded.poll) && !ownUnvoted) return fail(response, 403, "recht_fehlt");
    ctx.db.prepare("DELETE FROM polls_options WHERE id = ?").run(option.id);
    changed(loaded.poll.id);
    response.json(serialize(user, loaded.poll, loaded.event));
  });

  // ---------- Abstimmen ----------

  /** Ersetzt alle eigenen Stimmen dieser Abstimmung. Leere Liste = Stimme zurückziehen. */
  ctx.router.put("/polls/:id/vote", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    const loaded = loadVisible(user, String(request.params.id), response);
    if (!loaded) return;
    const { poll, event } = loaded;
    if (!canVote(user, poll)) return fail(response, 403, "recht_fehlt");
    if (!isOpen(poll, event)) return fail(response, 409, "abstimmung_geschlossen");
    const parsed = voteInput.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "stimme_ungueltig");
    const optionIds = new Set((ctx.db.prepare("SELECT id FROM polls_options WHERE poll_id = ?").all(poll.id) as Array<{ id: string }>).map((row) => row.id));
    const votes = new Map(parsed.data.votes.map((vote) => [vote.optionId, vote.value] as const));
    if ([...votes.keys()].some((id) => !optionIds.has(id))) return fail(response, 400, "option_nicht_gefunden");
    if (poll.kind !== "date") {
      if ([...votes.values()].some((value) => value !== "yes")) return fail(response, 400, "stimme_ungueltig");
      if (!poll.multiple && votes.size > 1) return fail(response, 400, "nur_eine_option");
    }
    ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM polls_votes WHERE poll_id = ? AND user_id = ?").run(poll.id, user.id);
      const insert = ctx.db.prepare("INSERT INTO polls_votes (option_id, poll_id, user_id, value, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const [optionId, value] of votes) insert.run(optionId, poll.id, user.id, value, now());
    })();
    changed(poll.id);
    response.json(serialize(user, poll, event));
  });

  ctx.log.info("Modul Abstimmungen gestartet");
}
