CREATE TABLE IF NOT EXISTS hallo_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  main_event_id TEXT REFERENCES main_events (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hallo_notes_created ON hallo_notes (created_at);
