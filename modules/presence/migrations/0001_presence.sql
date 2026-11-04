-- „Spielt gerade“. Bis Matchdesk 0.16 hießen die Tabellen game_agent_keys, user_game_accounts und
-- user_game_account_prefs; der Kern benennt sie beim Update um (Kern-Migration 0039), Daten bleiben.

-- Ein Schlüssel pro Benutzer für den Windows-Agenten. Er darf nur POST/DELETE /game, nichts sonst.
CREATE TABLE IF NOT EXISTS presence_agent_keys (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS presence_agent_keys_key_hash_unique ON presence_agent_keys(key_hash);

-- Spielkonten (Steam, EA, Battle.net, Epic, Ubisoft) pro Benutzer. Steam kommt bevorzugt vom
-- Agenten (SteamID64 + Anzeigename), der Rest wird im Profil gepflegt.
CREATE TABLE IF NOT EXISTS presence_game_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('steam', 'ea', 'battlenet', 'epic', 'ubisoft')),
  account_id TEXT NOT NULL,
  display_name TEXT,
  source TEXT NOT NULL CHECK (source IN ('agent', 'manual')),
  -- Vom Agenten erkanntes, abweichendes Konto; wartet auf „übernehmen“.
  pending_account_id TEXT,
  pending_display_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, platform)
);

-- „Nicht mehr fragen“ für die Nachfrage nach dem Login.
CREATE TABLE IF NOT EXISTS presence_game_account_prefs (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt_dismissed_at TEXT
);
