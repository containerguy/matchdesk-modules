-- Versandprotokoll ohne Telefonnummer und Text: nur wer, wann, Ergebnis (für Tageslimit und Admin-Ansicht).
CREATE TABLE IF NOT EXISTS sms_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  main_event_id TEXT REFERENCES main_events (id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  gateway_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sms_log_created ON sms_log (created_at);
