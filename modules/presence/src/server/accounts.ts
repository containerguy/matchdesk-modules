import type Database from "better-sqlite3";
import { z } from "zod";

/**
 * Spielkonten pro Benutzer. Entscheidung (René, 2026-11-04): Wer den Agenten installiert, stimmt
 * der Nutzung zu. Steam übernimmt der Agent automatisch, solange noch kein Steam-Konto hinterlegt
 * ist; weicht ein erkanntes Konto ab, wartet es als Vorschlag auf „übernehmen“. EA, Battle.net,
 * Epic und Ubisoft pflegt man selbst im Profil.
 */
export const GAME_PLATFORMS = ["steam", "ea", "battlenet", "epic", "ubisoft"] as const;
export type GamePlatform = (typeof GAME_PLATFORMS)[number];

const STEAM_ID64 = /^7656119\d{10}$/;

export const steamAccountSchema = z.object({
  steamId: z.string().regex(STEAM_ID64),
  personaName: z.string().trim().max(64).optional()
});
export type SteamAccountReport = z.infer<typeof steamAccountSchema>;

const manualValue = z.string().trim().max(64).nullable().optional();

/** Profil-Formular: `null` oder leer löscht, fehlendes Feld bleibt unverändert. */
export const gameAccountsUpdateSchema = z.object({
  steam: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === null || value === "") {
        return value === "" ? null : value;
      }
      const id = parseSteamInput(value);
      if (!id) {
        ctx.addIssue({ code: "custom", message: "steam_id_ungueltig" });
        return z.NEVER;
      }
      return id;
    }),
  ea: manualValue,
  battlenet: manualValue,
  epic: manualValue,
  ubisoft: manualValue
});

/** SteamID64 direkt oder aus einem Profil-Link `steamcommunity.com/profiles/<id>`. */
export function parseSteamInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (STEAM_ID64.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/);
  return match?.[1];
}

export type GameAccountView = {
  accountId: string;
  displayName: string | null;
  source: "agent" | "manual";
  pending?: { accountId: string; displayName: string | null };
};

type AccountRow = {
  user_id: string;
  platform: GamePlatform;
  account_id: string;
  display_name: string | null;
  source: "agent" | "manual";
  pending_account_id: string | null;
  pending_display_name: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function steamRow(db: Database.Database, userId: string) {
  return db
    .prepare("SELECT * FROM presence_game_accounts WHERE user_id = ? AND platform = 'steam'")
    .get(userId) as AccountRow | undefined;
}

export function getGameAccounts(db: Database.Database, userId: string) {
  const rows = db.prepare("SELECT * FROM presence_game_accounts WHERE user_id = ?").all(userId) as AccountRow[];
  const accounts: Partial<Record<GamePlatform, GameAccountView>> = {};
  for (const row of rows) {
    accounts[row.platform] = {
      accountId: row.account_id,
      displayName: row.display_name,
      source: row.source,
      ...(row.pending_account_id
        ? { pending: { accountId: row.pending_account_id, displayName: row.pending_display_name } }
        : {})
    };
  }
  const prefs = db
    .prepare("SELECT prompt_dismissed_at FROM presence_game_account_prefs WHERE user_id = ?")
    .get(userId) as { prompt_dismissed_at: string | null } | undefined;
  const missing = GAME_PLATFORMS.filter((platform) => !accounts[platform]);
  return { accounts, missing, promptDismissed: Boolean(prefs?.prompt_dismissed_at) };
}

/**
 * Steam-Konto vom Agenten. Rückgabe: was passiert ist (für Tests und Logs).
 * - kein Steam-Konto hinterlegt → übernehmen
 * - gleiches Konto → Anzeigenamen aktualisieren, Vorschlag verwerfen
 * - anderes Konto → als Vorschlag ablegen
 */
export function reportSteamAccount(
  db: Database.Database,
  userId: string,
  report: SteamAccountReport
): "stored" | "updated" | "pending" | "unchanged" {
  const name = report.personaName?.trim() || null;
  const existing = steamRow(db, userId);
  const stamp = nowIso();

  if (!existing) {
    db.prepare(
      `INSERT INTO presence_game_accounts (user_id, platform, account_id, display_name, source, updated_at)
       VALUES (?, 'steam', ?, ?, 'agent', ?)`
    ).run(userId, report.steamId, name, stamp);
    return "stored";
  }
  if (existing.account_id === report.steamId) {
    if (existing.display_name === name && !existing.pending_account_id) {
      return "unchanged";
    }
    db.prepare(
      `UPDATE presence_game_accounts SET display_name = ?, pending_account_id = NULL, pending_display_name = NULL, updated_at = ?
       WHERE user_id = ? AND platform = 'steam'`
    ).run(name ?? existing.display_name, stamp, userId);
    return "updated";
  }
  if (existing.pending_account_id === report.steamId && existing.pending_display_name === name) {
    return "unchanged";
  }
  db.prepare(
    `UPDATE presence_game_accounts SET pending_account_id = ?, pending_display_name = ?, updated_at = ?
     WHERE user_id = ? AND platform = 'steam'`
  ).run(report.steamId, name, stamp, userId);
  return "pending";
}

export function acceptPendingSteam(db: Database.Database, userId: string): boolean {
  const existing = steamRow(db, userId);
  if (!existing?.pending_account_id) {
    return false;
  }
  db.prepare(
    `UPDATE presence_game_accounts
     SET account_id = ?, display_name = ?, source = 'agent', pending_account_id = NULL, pending_display_name = NULL, updated_at = ?
     WHERE user_id = ? AND platform = 'steam'`
  ).run(existing.pending_account_id, existing.pending_display_name, nowIso(), userId);
  return true;
}

export function dismissPendingSteam(db: Database.Database, userId: string) {
  db.prepare(
    "UPDATE presence_game_accounts SET pending_account_id = NULL, pending_display_name = NULL WHERE user_id = ? AND platform = 'steam'"
  ).run(userId);
}

export function updateGameAccounts(db: Database.Database, userId: string, input: z.infer<typeof gameAccountsUpdateSchema>) {
  const stamp = nowIso();
  const select = db.prepare("SELECT account_id FROM presence_game_accounts WHERE user_id = ? AND platform = ?");
  const remove = db.prepare("DELETE FROM presence_game_accounts WHERE user_id = ? AND platform = ?");
  const update = db.prepare(
    `UPDATE presence_game_accounts
     SET account_id = ?, display_name = NULL, source = 'manual', pending_account_id = NULL, pending_display_name = NULL, updated_at = ?
     WHERE user_id = ? AND platform = ?`
  );
  const insert = db.prepare(
    `INSERT INTO presence_game_accounts (user_id, platform, account_id, display_name, source, updated_at)
     VALUES (?, ?, ?, NULL, 'manual', ?)`
  );
  db.transaction(() => {
    for (const platform of GAME_PLATFORMS) {
      const value = input[platform];
      if (value === undefined) {
        continue;
      }
      const trimmed = value?.trim() ?? "";
      if (!trimmed) {
        remove.run(userId, platform);
        continue;
      }
      const existing = select.get(userId, platform) as { account_id: string } | undefined;
      if (existing?.account_id === trimmed) {
        continue;
      }
      if (existing) update.run(trimmed, stamp, userId, platform);
      else insert.run(userId, platform, trimmed, stamp);
    }
  })();
}

export function dismissGameAccountPrompt(db: Database.Database, userId: string) {
  db.prepare(
    `INSERT INTO presence_game_account_prefs (user_id, prompt_dismissed_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET prompt_dismissed_at = excluded.prompt_dismissed_at`
  ).run(userId, nowIso());
}

/** Spielkonten aller aktiven Benutzer, die mindestens eins hinterlegt haben (ohne Vorschläge). */
export function listAllGameAccounts(db: Database.Database) {
  const rows = db
    .prepare(
      `SELECT a.user_id AS userId, u.username AS username, u.display_name AS displayName, a.platform AS platform,
              a.account_id AS accountId, a.display_name AS accountName
       FROM presence_game_accounts a JOIN users u ON u.id = a.user_id
       WHERE u.deleted_at IS NULL`
    )
    .all() as Array<{
    userId: string;
    username: string;
    displayName: string | null;
    platform: GamePlatform;
    accountId: string;
    accountName: string | null;
  }>;
  const byUser = new Map<
    string,
    {
      userId: string;
      username: string;
      displayName: string | null;
      accounts: Partial<Record<GamePlatform, { accountId: string; displayName: string | null }>>;
    }
  >();
  for (const row of rows) {
    let entry = byUser.get(row.userId);
    if (!entry) {
      entry = { userId: row.userId, username: row.username, displayName: row.displayName, accounts: {} };
      byUser.set(row.userId, entry);
    }
    entry.accounts[row.platform] = { accountId: row.accountId, displayName: row.accountName };
  }
  return Array.from(byUser.values()).sort((a, b) => a.username.localeCompare(b.username));
}
