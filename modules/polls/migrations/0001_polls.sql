CREATE TABLE IF NOT EXISTS polls_polls (
  id TEXT PRIMARY KEY,
  main_event_id TEXT REFERENCES main_events (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  multiple INTEGER NOT NULL DEFAULT 0,
  allow_suggestions INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  closes_at TEXT,
  closed_at TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS polls_polls_event ON polls_polls (main_event_id);

CREATE TABLE IF NOT EXISTS polls_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls_polls (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  starts_at TEXT,
  position INTEGER NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS polls_options_poll ON polls_options (poll_id);

-- Eine Stimme pro Option und Person; value: yes (Auswahl) oder yes/maybe/no bei Terminen.
CREATE TABLE IF NOT EXISTS polls_votes (
  option_id TEXT NOT NULL REFERENCES polls_options (id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL REFERENCES polls_polls (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (option_id, user_id)
);

CREATE INDEX IF NOT EXISTS polls_votes_poll ON polls_votes (poll_id);
