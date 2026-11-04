-- Listen eines Events: install (Download/Installation), bring (Mitbringen), lend (Verleih).
CREATE TABLE IF NOT EXISTS extras_items (
  id TEXT PRIMARY KEY,
  main_event_id TEXT NOT NULL REFERENCES main_events (id) ON DELETE CASCADE,
  list TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  url TEXT,
  quantity INTEGER,
  owner_user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  borrowed_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  borrowed_at TEXT,
  returned_at TEXT,
  position INTEGER NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS extras_items_event ON extras_items (main_event_id, list);

-- „Ich bringe mit“: wer bringt wie viel von einem Eintrag der Mitbringliste.
CREATE TABLE IF NOT EXISTS extras_bring_claims (
  item_id TEXT NOT NULL REFERENCES extras_items (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

-- Abgehakte Einträge der Installationsliste je Person.
CREATE TABLE IF NOT EXISTS extras_install_done (
  item_id TEXT NOT NULL REFERENCES extras_items (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  done_at TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

-- Unkostenbeitrag pro Person (Betrag in Cent).
CREATE TABLE IF NOT EXISTS extras_costs (
  main_event_id TEXT PRIMARY KEY REFERENCES main_events (id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  note TEXT,
  paypal_url TEXT,
  due_date TEXT,
  updated_at TEXT NOT NULL
);

-- status: reported (Teilnehmer meldet „bezahlt“) oder confirmed (Verwalter bestätigt).
CREATE TABLE IF NOT EXISTS extras_payments (
  main_event_id TEXT NOT NULL REFERENCES main_events (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  reported_at TEXT,
  confirmed_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at TEXT,
  PRIMARY KEY (main_event_id, user_id)
);

-- Fahrgemeinschaften: Fahrer bieten Plätze an, direction = there | back | both.
CREATE TABLE IF NOT EXISTS extras_rides (
  id TEXT PRIMARY KEY,
  main_event_id TEXT NOT NULL REFERENCES main_events (id) ON DELETE CASCADE,
  driver_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  start_place TEXT NOT NULL,
  departs_at TEXT,
  seats INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS extras_rides_event ON extras_rides (main_event_id);

CREATE TABLE IF NOT EXISTS extras_ride_seats (
  ride_id TEXT NOT NULL REFERENCES extras_rides (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ride_id, user_id)
);

-- Zusatzfragen pro Event (z. B. „bringe eigenen PC mit“, „Ankunft“). kind = text | checkbox | choice.
CREATE TABLE IF NOT EXISTS extras_fields (
  id TEXT PRIMARY KEY,
  main_event_id TEXT NOT NULL REFERENCES main_events (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  choices TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extras_field_answers (
  field_id TEXT NOT NULL REFERENCES extras_fields (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (field_id, user_id)
);
