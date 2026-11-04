import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import type { ModuleContext } from "@matchdesk/module-sdk";
import {
  acceptPendingSteam,
  dismissGameAccountPrompt,
  dismissPendingSteam,
  gameAccountsUpdateSchema,
  getGameAccounts,
  listAllGameAccounts,
  reportSteamAccount,
  updateGameAccounts
} from "./server/accounts";
import { createPresenceStore, presenceReportSchema } from "./server/presence-store";

/**
 * „Spielt gerade“ (bis Matchdesk 0.16 im Kern unter /api/presence).
 *
 * - GET    /                      wer spielt gerade was (nur angemeldet)
 * - POST   /game                  Bericht des Agenten (`{ playing: [...] }`)
 * - DELETE /game                  eigenen Eintrag sofort entfernen (Agent beendet)
 * - POST   /agent-key             Agent-Schlüssel (neu) anlegen, alter wird ungültig
 * - DELETE /agent-key             Agent-Schlüssel widerrufen
 * - GET    /agent/download        Windows-Agent (liegt im Modulpaket unter assets/)
 * - GET    /accounts              Spielkonten aller Teilnehmer
 * - GET    /accounts/me           eigene Spielkonten (+ fehlende, Steam-Vorschlag)
 * - PUT    /accounts/me           eigene Spielkonten pflegen
 * - POST   /accounts/me/steam/accept|dismiss   Steam-Vorschlag des Agenten
 * - POST   /accounts/me/prompt-dismiss          „Nicht mehr fragen“
 *
 * Der Agent meldet sich mit seinem Schlüssel (`Bearer md_ga_…`). Der Schlüssel taugt nur für
 * `/game`; Sitzung + CSRF oder ein API-Token mit Vollzugriff gehen dort ebenfalls.
 */

export const AGENT_KEY_PREFIX = "md_ga_";
/** Wie der Kern: Ohne neue Meldung verschwinden Einträge, geprüft alle 30 s. */
const SWEEP_INTERVAL_MS = 30_000;

export type PresenceOptions = { agentPath?: string; ttlMs?: number; now?: () => number };

function defaultAgentPath() {
  try {
    return fileURLToPath(new URL("./assets/matchdesk-game-agent.exe", import.meta.url));
  } catch {
    return "";
  }
}

function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

function bearer(request: Request) {
  const match = request.get("authorization")?.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

export function register(ctx: ModuleContext, options: PresenceOptions = {}) {
  const db = ctx.db;
  const store = createPresenceStore({ ttlMs: options.ttlMs, now: options.now });
  const agentPath = options.agentPath ?? defaultAgentPath();
  const agentAvailable = () => Boolean(agentPath) && fs.existsSync(agentPath);
  const router = ctx.router;

  ctx.schedule(SWEEP_INTERVAL_MS, () => store.sweep());
  ctx.onStop(() => store.clearAll());

  function issueAgentKey(userId: string) {
    const key = `${AGENT_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO presence_agent_keys (user_id, key_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, last_used_at = NULL`
    ).run(userId, hashKey(key), createdAt);
    return { key, createdAt };
  }

  function agentKeyInfo(userId: string) {
    const row = db
      .prepare("SELECT created_at AS createdAt, last_used_at AS lastUsedAt FROM presence_agent_keys WHERE user_id = ?")
      .get(userId) as { createdAt: string; lastUsedAt: string | null } | undefined;
    return row ?? null;
  }

  /** Benutzer zum Schlüssel (nur aktive, nicht gelöschte Benutzer) und letzte Nutzung vermerken. */
  function resolveAgentKey(key: string) {
    const row = db
      .prepare(
        `SELECT k.user_id AS userId FROM presence_agent_keys k JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = ? AND u.deleted_at IS NULL`
      )
      .get(hashKey(key)) as { userId: string } | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE presence_agent_keys SET last_used_at = ? WHERE user_id = ?").run(new Date().toISOString(), row.userId);
    return row.userId;
  }

  function guard(request: Request, response: Response) {
    const user = ctx.currentUser(request);
    if (!user) {
      response.status(401).json({ error: "nicht_angemeldet" });
      return undefined;
    }
    return user;
  }

  /** Schreibender Zugriff für den eigenen Benutzer: Sitzung + CSRF oder API-Token mit Vollzugriff. */
  function guardWrite(request: Request, response: Response) {
    const user = guard(request, response);
    if (!user || !ctx.requireWrite(request, response)) return undefined;
    return user.id;
  }

  /** Für /game zusätzlich: Agent-Schlüssel. */
  function guardReport(request: Request, response: Response) {
    const key = bearer(request);
    if (key?.startsWith(AGENT_KEY_PREFIX)) {
      const userId = resolveAgentKey(key);
      if (!userId) {
        response.status(401).json({ error: "agent_schluessel_ungueltig" });
        return undefined;
      }
      return userId;
    }
    return guardWrite(request, response);
  }

  router.get("/", (request, response) => {
    const user = guard(request, response);
    if (!user) return;
    const entries = store.list();
    const userIds = entries.map((entry) => entry.userId);
    const rows =
      userIds.length === 0
        ? []
        : (db
            .prepare(
              `SELECT id, username, display_name AS displayName FROM users
               WHERE deleted_at IS NULL AND id IN (${userIds.map(() => "?").join(", ")})`
            )
            .all(...userIds) as Array<{ id: string; username: string; displayName: string | null }>);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const players = entries
      .filter((entry) => byId.has(entry.userId))
      .map((entry) => {
        const row = byId.get(entry.userId)!;
        return {
          userId: entry.userId,
          username: row.username,
          displayName: row.displayName,
          games: entry.games,
          updatedAt: entry.updatedAt
        };
      })
      .sort((a, b) => a.username.localeCompare(b.username));
    response.json({ players, agentAvailable: agentAvailable(), agentKey: agentKeyInfo(user.id) });
  });

  router.post("/game", (request, response) => {
    const userId = guardReport(request, response);
    if (!userId) return;
    const parsed = presenceReportSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "ungueltige_meldung" });
      return;
    }
    store.report(userId, parsed.data.playing);
    if (parsed.data.steamAccount) {
      reportSteamAccount(db, userId, parsed.data.steamAccount);
    }
    response.status(204).end();
  });

  router.delete("/game", (request, response) => {
    const userId = guardReport(request, response);
    if (!userId) return;
    store.clear(userId);
    response.status(204).end();
  });

  router.post("/agent-key", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    response.status(201).json(issueAgentKey(userId));
  });

  router.delete("/agent-key", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    db.prepare("DELETE FROM presence_agent_keys WHERE user_id = ?").run(userId);
    store.clear(userId);
    response.status(204).end();
  });

  router.get("/accounts", (request, response) => {
    if (!guard(request, response)) return;
    response.json({ users: listAllGameAccounts(db) });
  });

  router.get("/accounts/me", (request, response) => {
    const user = guard(request, response);
    if (!user) return;
    response.json(getGameAccounts(db, user.id));
  });

  router.put("/accounts/me", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    const parsed = gameAccountsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      const steamInvalid = parsed.error.issues.some((issue) => issue.message === "steam_id_ungueltig");
      response.status(400).json({ error: steamInvalid ? "steam_id_ungueltig" : "ungueltige_eingabe" });
      return;
    }
    updateGameAccounts(db, userId, parsed.data);
    response.json(getGameAccounts(db, userId));
  });

  router.post("/accounts/me/steam/accept", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    if (!acceptPendingSteam(db, userId)) {
      response.status(404).json({ error: "kein_vorschlag" });
      return;
    }
    response.json(getGameAccounts(db, userId));
  });

  router.post("/accounts/me/steam/dismiss", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    dismissPendingSteam(db, userId);
    response.json(getGameAccounts(db, userId));
  });

  router.post("/accounts/me/prompt-dismiss", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    dismissGameAccountPrompt(db, userId);
    response.status(204).end();
  });

  router.get("/agent/download", (request, response) => {
    if (!guard(request, response)) return;
    if (!agentAvailable()) {
      response.status(404).json({ error: "agent_nicht_vorhanden" });
      return;
    }
    response.download(agentPath, "matchdesk-game-agent.exe", {
      headers: { "Content-Type": "application/vnd.microsoft.portable-executable" }
    });
  });
}
