CREATE TABLE IF NOT EXISTS arena_matches (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  main_event_id TEXT REFERENCES main_events (id) ON DELETE SET NULL,
  challenger_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  opponent_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  -- open: Tisch reserviert, finished: mindestens eine Partie gewertet, cancelled/expired: ohne Ergebnis zu
  status TEXT NOT NULL,
  table_id TEXT,
  challenger_token TEXT,
  opponent_token TEXT,
  challenger_score INTEGER NOT NULL DEFAULT 0,
  opponent_score INTEGER NOT NULL DEFAULT 0,
  winner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS arena_matches_status ON arena_matches (status, updated_at);
CREATE INDEX IF NOT EXISTS arena_matches_table ON arena_matches (table_id);
