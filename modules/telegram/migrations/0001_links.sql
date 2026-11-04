-- Verknüpfung Matchdesk-Konto ↔ Telegram-Chat. Ein Telegram-Chat gehört höchstens einem Konto.
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  linked_at TEXT NOT NULL,
  blocked_at TEXT
);

-- Einmal-Codes für den Link https://t.me/<bot>?start=<code>, gültig wenige Minuten.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
