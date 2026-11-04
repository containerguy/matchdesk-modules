-- Pizzabestellung: Tabellen wie in Matchdesk bis Kern-Migration 0036.
-- Bestehende Installationen haben die Tabellen schon (IF NOT EXISTS), neue bekommen sie hier.

CREATE TABLE IF NOT EXISTS pizza_menu_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pizza_menu_items (
  id TEXT PRIMARY KEY NOT NULL,
  number TEXT,
  name TEXT NOT NULL,
  ingredients TEXT,
  allergens TEXT,
  category_id TEXT NOT NULL REFERENCES pizza_menu_categories(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pizza_menu_variants (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES pizza_menu_items(id) ON DELETE CASCADE,
  size_label TEXT,
  price_cents INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS pizza_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'locked', 'delivered')),
  label TEXT,
  opened_at TEXT,
  opened_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  locked_at TEXT,
  locked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  delivered_at TEXT,
  delivered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, archived_at TEXT, archived_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, main_event_id TEXT REFERENCES main_events(id) ON DELETE SET NULL);

CREATE TABLE IF NOT EXISTS pizza_orders (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES pizza_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid_paypal', 'paid_cash')),
  paid_at TEXT,
  paid_by_admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, payment_method TEXT
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'paypal')));

CREATE TABLE IF NOT EXISTS pizza_order_lines (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES pizza_orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES pizza_menu_variants(id) ON DELETE RESTRICT,
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 3),
  price_cents_snapshot INTEGER NOT NULL,
  custom_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pizza_menu_extras (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pizza_menu_extra_categories (
  extra_id TEXT NOT NULL REFERENCES pizza_menu_extras(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES pizza_menu_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (extra_id, category_id)
);

CREATE TABLE IF NOT EXISTS pizza_order_line_extras (
  line_id TEXT NOT NULL REFERENCES pizza_order_lines(id) ON DELETE CASCADE,
  extra_id TEXT NOT NULL REFERENCES pizza_menu_extras(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL,
  price_cents_snapshot INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (line_id, extra_id)
);

CREATE INDEX IF NOT EXISTS pizza_menu_variants_item_idx ON pizza_menu_variants(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS pizza_orders_session_user_unique ON pizza_orders(session_id, user_id);
CREATE INDEX IF NOT EXISTS pizza_order_lines_order_idx ON pizza_order_lines(order_id);
CREATE INDEX IF NOT EXISTS pizza_sessions_archived_created_idx ON pizza_sessions(archived_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS pizza_menu_categories_name_unique ON pizza_menu_categories(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS pizza_menu_items_active_sort_idx ON pizza_menu_items(active, sort_order);
CREATE INDEX IF NOT EXISTS pizza_menu_items_category_idx ON pizza_menu_items(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS pizza_menu_extras_name_unique ON pizza_menu_extras(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS pizza_menu_extra_categories_category_idx ON pizza_menu_extra_categories(category_id);
CREATE INDEX IF NOT EXISTS pizza_order_line_extras_extra_idx ON pizza_order_line_extras(extra_id);
CREATE INDEX IF NOT EXISTS pizza_sessions_event_idx ON pizza_sessions(main_event_id, archived_at);

INSERT OR IGNORE INTO pizza_menu_categories (id, name, sort_order, active, created_at, updated_at) VALUES
  ('cat-pizza', 'Pizza', 1, 1, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'),
  ('cat-pasta', 'Pasta', 2, 1, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
