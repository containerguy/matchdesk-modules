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
 * - DELETE /agent-key             Agent trennen (Schlüssel widerrufen)
 * - POST   /agent/pair-code       Einmalcode zum Verbinden des Agenten (5 min, Link matchdesk-agent://)
 * - POST   /agent/pair            Agent tauscht den Einmalcode gegen seinen Schlüssel (ohne Anmeldung)
 * - GET    /agent/version         aktuelle Agent-Version (Update-Hinweis im Tray)
 * - GET    /agent/download        Installer des Windows-Agenten (liegt im Modulpaket unter assets/)
 * - GET    /accounts              Spielkonten aller Teilnehmer
 * - GET    /accounts/me           eigene Spielkonten (+ fehlende, Steam-Vorschlag)
 * - PUT    /accounts/me           eigene Spielkonten pflegen
 * - POST   /accounts/me/steam/accept|dismiss   Steam-Vorschlag des Agenten
 * - POST   /accounts/me/prompt-dismiss          „Nicht mehr fragen“
 *
 * Der Agent meldet sich mit seinem Schlüssel (`Bearer md_ga_…`). Der Schlüssel taugt nur für
 * `/game`, `/agent/version` und `/agent/download`; Sitzung + CSRF oder ein API-Token mit
 * Vollzugriff gehen dort ebenfalls. Den Schlüssel bekommt der Agent nur über den Einmalcode,
 * er erscheint nie im Browser.
 */

export const AGENT_KEY_PREFIX = "md_ga_";
/** Wie der Kern: Ohne neue Meldung verschwinden Einträge, geprüft alle 30 s. */
const SWEEP_INTERVAL_MS = 30_000;

/** Einmalcode: 8 Zeichen ohne verwechselbare (0/O, 1/I/L), 5 Minuten gültig. */
const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIR_CODE_TTL_MS = 5 * 60_000;
/** Falsche Codes: höchstens so viele pro Minute, danach 429 (gegen Durchprobieren). */
const PAIR_FAILURES_PER_MINUTE = 20;
export const AGENT_INSTALLER_NAME = "Mitspielzentrale-Agent-Setup.exe";

export type PresenceOptions = { agentPath?: string; ttlMs?: number; now?: () => number };

export function normalizePairCode(code: string) {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function newPairCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length]).join("");
}

function defaultAgentPath() {
  try {
    return fileURLToPath(new URL("./assets/matchdesk-agent-setup.exe", import.meta.url));
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
  const now = options.now ?? Date.now;
  /** Einmalcodes nur im Speicher: Hash des Codes -> Benutzer + Ablauf. Ein Code pro Benutzer. */
  const pairCodes = new Map<string, { userId: string; expiresAt: number }>();
  let pairFailures = { windowStart: 0, count: 0 };

  ctx.schedule(SWEEP_INTERVAL_MS, () => {
    store.sweep();
    for (const [hash, entry] of pairCodes) if (entry.expiresAt <= now()) pairCodes.delete(hash);
  });
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

  /** Lesender Zugriff für den Agenten (Version, Download): Agent-Schlüssel oder Sitzung. */
  function guardAgentRead(request: Request, response: Response) {
    const key = bearer(request);
    if (key?.startsWith(AGENT_KEY_PREFIX)) {
      const userId = resolveAgentKey(key);
      if (!userId) response.status(401).json({ error: "agent_schluessel_ungueltig" });
      return userId;
    }
    return guard(request, response)?.id;
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

  router.post("/agent/pair-code", (request, response) => {
    const userId = guardWrite(request, response);
    if (!userId) return;
    for (const [hash, entry] of pairCodes) if (entry.userId === userId) pairCodes.delete(hash);
    const code = newPairCode();
    const expiresAt = now() + PAIR_CODE_TTL_MS;
    pairCodes.set(hashKey(code), { userId, expiresAt });
    response.status(201).json({ code, expiresAt: new Date(expiresAt).toISOString() });
  });

  /** Ohne Anmeldung: Der Einmalcode ist der Nachweis. Er gilt genau einmal. */
  router.post("/agent/pair", (request, response) => {
    const t = now();
    if (t - pairFailures.windowStart >= 60_000) pairFailures = { windowStart: t, count: 0 };
    if (pairFailures.count >= PAIR_FAILURES_PER_MINUTE) {
      response.status(429).json({ error: "zu_viele_versuche" });
      return;
    }
    const raw = typeof request.body?.code === "string" ? normalizePairCode(request.body.code) : "";
    const hash = hashKey(raw);
    const entry = raw.length === 8 ? pairCodes.get(hash) : undefined;
    if (!entry || entry.expiresAt <= t) {
      if (entry) pairCodes.delete(hash);
      pairFailures.count += 1;
      response.status(400).json({ error: "code_ungueltig" });
      return;
    }
    pairCodes.delete(hash);
    const user = db
      .prepare("SELECT username, display_name AS displayName FROM users WHERE id = ? AND deleted_at IS NULL")
      .get(entry.userId) as { username: string; displayName: string | null } | undefined;
    if (!user) {
      response.status(400).json({ error: "code_ungueltig" });
      return;
    }
    const { key } = issueAgentKey(entry.userId);
    response.status(201).json({ key, username: user.username, displayName: user.displayName });
  });

  router.get("/agent/version", (request, response) => {
    if (!guardAgentRead(request, response)) return;
    response.json({ version: ctx.version, available: agentAvailable() });
  });

  router.get("/agent/download", (request, response) => {
    if (!guardAgentRead(request, response)) return;
    if (!agentAvailable()) {
      response.status(404).json({ error: "agent_nicht_vorhanden" });
      return;
    }
    response.download(agentPath, AGENT_INSTALLER_NAME, {
      headers: { "Content-Type": "application/vnd.microsoft.portable-executable" }
    });
  });
}
