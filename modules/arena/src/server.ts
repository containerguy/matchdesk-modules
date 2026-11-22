import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ModuleContext, ModuleUser } from "@matchdesk/module-sdk";
import { GAMES, findGame, joinUrl, type GameDef } from "./games";
import type { ArenaSettings } from "./settings";

type MatchRow = {
  id: string;
  game: string;
  main_event_id: string | null;
  challenger_id: string | null;
  opponent_id: string | null;
  status: "open" | "finished" | "cancelled" | "expired";
  table_id: string | null;
  challenger_token: string | null;
  opponent_token: string | null;
  challenger_score: number;
  opponent_score: number;
  winner_id: string | null;
  games_played: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type UserRow = { id: string; username: string; display_name: string | null };

/** Ereignis eines Spielservers (siehe matchdesk-billiard, README „Einbindung“). */
type TableEvent = {
  type: "game.finished" | "table.expired" | "table.closed";
  reason?: string;
  table: {
    id: string;
    ref: string | null;
    status: string;
    winner: string | null;
    gamesPlayed: number;
    players: Array<{ id: string; score: number }>;
  };
};

/** Signaturen älter als fünf Minuten gelten als Wiederholung. */
const MAX_SKEW_SECONDS = 300;

export function register(ctx: ModuleContext) {
  const settings = () => ctx.settings.get() as ArenaSettings;
  const now = () => new Date().toISOString();

  function availableGames() {
    const s = settings();
    return GAMES.filter((game) => game.enabled(s) && game.apiUrl(s) && ctx.env(game.apiKeySecret));
  }

  function userName(id: string | null) {
    if (!id) return null;
    const row = ctx.db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? (row.display_name ?? row.username) : null;
  }

  function view(match: MatchRow, viewer: ModuleUser | undefined) {
    const s = settings();
    const game = findGame(match.game);
    const mySide = viewer?.id === match.challenger_id ? "challenger" : viewer?.id === match.opponent_id ? "opponent" : null;
    const token = mySide === "challenger" ? match.challenger_token : mySide === "opponent" ? match.opponent_token : null;
    return {
      id: match.id,
      game: match.game,
      mainEventId: match.main_event_id,
      status: match.status,
      challenger: { id: match.challenger_id, name: userName(match.challenger_id), score: match.challenger_score },
      opponent: { id: match.opponent_id, name: userName(match.opponent_id), score: match.opponent_score },
      winner: match.winner_id ? { id: match.winner_id, name: userName(match.winner_id) } : null,
      gamesPlayed: match.games_played,
      createdAt: match.created_at,
      updatedAt: match.updated_at,
      mine: mySide !== null,
      embedUrl:
        token && game && match.status !== "cancelled" && match.status !== "expired"
          ? `${joinUrl(game.path(s), "")}?embed=1&seat=${encodeURIComponent(token)}`
          : null
    };
  }

  function getMatch(id: string) {
    return ctx.db.prepare("SELECT * FROM arena_matches WHERE id = ?").get(id) as MatchRow | undefined;
  }

  async function callGame(game: GameDef, method: string, path: string, body?: unknown) {
    const s = settings();
    const response = await ctx.http.fetch(joinUrl(game.apiUrl(s), `api/integrations/v1/${path}`), {
      method,
      headers: { authorization: `Bearer ${ctx.env(game.apiKeySecret) ?? ""}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return response;
  }

  function requirePlayer(request: Parameters<ModuleContext["currentUser"]>[0], response: import("express").Response) {
    const user = ctx.currentUser(request);
    if (!user) {
      response.status(401).json({ error: "nicht_angemeldet" });
      return undefined;
    }
    if (!ctx.can(user, "arena.play", { mainEventId: ctx.events.currentIdOf(user) })) {
      response.status(403).json({ error: "recht_fehlt" });
      return undefined;
    }
    return user;
  }

  // ---------- Spiele und Mitspieler ----------

  ctx.router.get("/games", (request, response) => {
    if (!requirePlayer(request, response)) return;
    response.json({ games: availableGames().map((game) => ({ id: game.id, name: game.name, description: game.description })) });
  });

  ctx.router.get("/players", (request, response) => {
    const user = requirePlayer(request, response);
    if (!user) return;
    const eventId = ctx.events.currentIdOf(user);
    const rows = ctx.db
      .prepare("SELECT id, username, display_name, role FROM users WHERE deleted_at IS NULL AND id <> ? ORDER BY username")
      .all(user.id) as Array<UserRow & { role: string }>;
    const players = rows
      .filter((row) => ctx.can({ id: row.id, role: row.role }, "arena.play", { mainEventId: eventId }))
      .map((row) => ({
        id: row.id,
        name: row.display_name ?? row.username,
        inEvent: eventId ? ctx.events.participantStatus(eventId, row.id) === "joined" : false
      }))
      .sort((a, b) => Number(b.inEvent) - Number(a.inEvent) || a.name.localeCompare(b.name));
    response.json({ mainEventId: eventId, players });
  });

  // ---------- Partien ----------

  ctx.router.get("/matches", (request, response) => {
    const user = requirePlayer(request, response);
    if (!user) return;
    const game = typeof request.query.game === "string" ? request.query.game : null;
    const filter = game ? "AND game = ?" : "";
    const args = game ? [game] : [];
    const mine = ctx.db
      .prepare(
        `SELECT * FROM arena_matches WHERE (challenger_id = ? OR opponent_id = ?) ${filter}
         ORDER BY status = 'open' DESC, updated_at DESC LIMIT 20`
      )
      .all(user.id, user.id, ...args) as MatchRow[];
    const recent = ctx.db
      .prepare(`SELECT * FROM arena_matches WHERE status = 'finished' ${filter} ORDER BY updated_at DESC LIMIT 10`)
      .all(...args) as MatchRow[];
    response.json({ mine: mine.map((m) => view(m, user)), recent: recent.map((m) => view(m, user)) });
  });

  ctx.router.get("/matches/:id", (request, response) => {
    const user = requirePlayer(request, response);
    if (!user) return;
    const match = getMatch(String(request.params.id));
    if (!match) return void response.status(404).json({ error: "nicht_gefunden" });
    response.json({ match: view(match, user) });
  });

  ctx.router.post("/matches", async (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = requirePlayer(request, response);
    if (!user) return;
    const game = availableGames().find((candidate) => candidate.id === request.body?.game);
    if (!game) return void response.status(400).json({ error: "spiel_unbekannt" });
    const opponentId = typeof request.body?.opponentId === "string" ? request.body.opponentId : "";
    const opponent = ctx.db
      .prepare("SELECT id, username, display_name, role FROM users WHERE id = ? AND deleted_at IS NULL")
      .get(opponentId) as (UserRow & { role: string }) | undefined;
    const eventId = ctx.events.currentIdOf(user);
    if (!opponent || opponent.id === user.id || !ctx.can({ id: opponent.id, role: opponent.role }, "arena.play", { mainEventId: eventId })) {
      return void response.status(400).json({ error: "gegner_ungueltig" });
    }
    const id = randomUUID();
    const s = settings();
    const callbackUrl = s.callbackBaseUrl ? joinUrl(s.callbackBaseUrl, `api/m/${ctx.id}/webhook/${game.id}`) : undefined;
    let table: { id: string; seats: Array<{ playerId: string; token: string }> };
    try {
      const result = await callGame(game, "POST", "tables", {
        ref: id,
        callbackUrl,
        players: [
          { id: user.id, name: user.displayName ?? user.username },
          { id: opponent.id, name: opponent.display_name ?? opponent.username }
        ]
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      table = (await result.json()) as typeof table;
    } catch (error) {
      ctx.log.error(`Tisch bei ${game.id} nicht angelegt`, error);
      return void response.status(502).json({ error: "spielserver_nicht_erreichbar" });
    }
    const token = (playerId: string) => table.seats.find((seat) => seat.playerId === playerId)?.token ?? null;
    const at = now();
    ctx.db
      .prepare(
        `INSERT INTO arena_matches (id, game, main_event_id, challenger_id, opponent_id, status, table_id, challenger_token, opponent_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
      )
      .run(id, game.id, eventId, user.id, opponent.id, table.id, token(user.id), token(opponent.id), at, at);
    ctx.audit({ actor: user, action: "match_created", summary: `${game.name.de}: Herausforderung an ${opponent.username}`, entityId: id });
    ctx.realtime.broadcast("matches_changed", { id });
    void ctx.push.toUsers([opponent.id], {
      title: `${game.name.de}: Herausforderung`,
      body: `${user.displayName ?? user.username} fordert dich heraus.`,
      url: `/#games/${ctx.id}/${game.id}/match/${id}`,
      requireInteraction: true
    });
    response.status(201).json({ match: view(getMatch(id)!, user) });
  });

  ctx.router.post("/matches/:id/cancel", async (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = requirePlayer(request, response);
    if (!user) return;
    const match = getMatch(String(request.params.id));
    if (!match) return void response.status(404).json({ error: "nicht_gefunden" });
    const participant = match.challenger_id === user.id || match.opponent_id === user.id;
    if (!participant && !ctx.can(user, "arena.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    if (match.status !== "open") return void response.status(409).json({ error: "nicht_offen" });
    const game = findGame(match.game);
    if (game && match.table_id) {
      await callGame(game, "DELETE", `tables/${encodeURIComponent(match.table_id)}`).catch((error) =>
        ctx.log.warn("Tisch nicht geschlossen", error)
      );
    }
    close(match.id, match.games_played > 0 ? "finished" : "cancelled");
    ctx.audit({ actor: user, action: "match_cancelled", summary: "Herausforderung abgesagt", entityId: match.id });
    response.json({ match: view(getMatch(match.id)!, user) });
  });

  function close(id: string, status: MatchRow["status"]) {
    const at = now();
    ctx.db
      .prepare("UPDATE arena_matches SET status = ?, challenger_token = NULL, opponent_token = NULL, closed_at = ?, updated_at = ? WHERE id = ?")
      .run(status, at, at, id);
    ctx.realtime.broadcast("matches_changed", { id });
  }

  // ---------- Ereignisse der Spielserver ----------

  ctx.router.post("/webhook/:game", (request, response) => {
    const game = findGame(String(request.params.game));
    const secret = game ? ctx.env(game.webhookSecret) : undefined;
    if (!game || !secret) return void response.status(404).json({ error: "nicht_gefunden" });
    if (typeof ctx.rawBody !== "function") return void response.status(501).json({ error: "kern_zu_alt" });
    const raw = ctx.rawBody(request);
    const timestamp = request.get("x-bandenduell-timestamp") ?? "";
    const signature = request.get("x-bandenduell-signature") ?? "";
    if (!raw || !verifySignature(secret, timestamp, raw, signature)) return void response.status(401).json({ error: "signatur_ungueltig" });
    const event = request.body as TableEvent;
    const match = event?.table?.ref ? getMatch(event.table.ref) : undefined;
    if (!match || match.table_id !== event.table.id) return void response.status(404).json({ error: "nicht_gefunden" });
    applyEvent(match, event);
    response.status(204).end();
  });

  function applyEvent(match: MatchRow, event: TableEvent) {
    const score = (userId: string | null) => event.table.players.find((p) => p.id === userId)?.score ?? 0;
    const at = now();
    if (event.type === "game.finished") {
      ctx.db
        .prepare(
          `UPDATE arena_matches SET status = 'finished', challenger_score = ?, opponent_score = ?, winner_id = ?, games_played = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(score(match.challenger_id), score(match.opponent_id), event.table.winner, event.table.gamesPlayed, at, match.id);
      ctx.audit({
        action: "match_finished",
        summary: `${findGame(match.game)?.name.de ?? match.game}: ${userName(match.challenger_id)} ${score(match.challenger_id)} : ${score(match.opponent_id)} ${userName(match.opponent_id)}`,
        entityId: match.id,
        metadata: { reason: event.reason ?? null, winner: event.table.winner }
      });
      ctx.realtime.broadcast("matches_changed", { id: match.id });
      return;
    }
    // Tisch verfallen oder geschlossen: Ergebnis bleibt, Links werden ungültig
    close(match.id, match.games_played > 0 || match.status === "finished" ? "finished" : event.type === "table.expired" ? "expired" : "cancelled");
  }

  // Rückfall, falls ein Ereignis verloren geht: offene Tische nachfragen
  ctx.schedule(60_000, async () => {
    const open = ctx.db
      .prepare("SELECT * FROM arena_matches WHERE table_id IS NOT NULL AND (status = 'open' OR (status = 'finished' AND closed_at IS NULL)) LIMIT 50")
      .all() as MatchRow[];
    for (const match of open) {
      const game = findGame(match.game);
      if (!game) continue;
      try {
        const result = await callGame(game, "GET", `tables/${encodeURIComponent(match.table_id!)}`);
        if (result.status === 404) {
          applyEvent(match, { type: "table.closed", table: { id: match.table_id!, ref: match.id, status: "gone", winner: null, gamesPlayed: 0, players: [] } });
          continue;
        }
        if (!result.ok) continue;
        const info = (await result.json()) as TableEvent["table"];
        if (info.gamesPlayed > match.games_played) applyEvent(match, { type: "game.finished", table: info });
      } catch (error) {
        ctx.log.warn(`Stand von ${game.id} nicht abrufbar`, error);
      }
    }
  });

  ctx.log.info("Modul Spiele gestartet");
}

export function verifySignature(secret: string, timestamp: string, raw: Buffer, signature: string, nowSeconds = Date.now() / 1000) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
