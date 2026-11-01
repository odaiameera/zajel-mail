-- The agent's own Telegram bot (TELEGRAM_BOT_TOKEN): urgent-mail alerts and
-- reminders sent to the one chat you linked, with buttons for reversible
-- actions only. Nothing typed into the chat is acted on.

-- The linked chat, one per login.
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id      TEXT PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  chat_id      TEXT NOT NULL UNIQUE,
  username     TEXT,
  urgent       INTEGER NOT NULL DEFAULT 1,  -- alert on mail Jev judges urgent
  paused       INTEGER NOT NULL DEFAULT 0,  -- /stop in the chat, or the switch in Settings
  linked_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time codes behind the t.me/<bot>?start=<code> link. Single use, short-lived.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- What each button on a sent message does. The button carries only this
-- random id, so a pressed button can't be made to name another email.
CREATE TABLE IF NOT EXISTS telegram_buttons (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id   TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('read', 'snooze', 'archive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);

-- Reminders the agent set ("remind me about this on Friday").
CREATE TABLE IF NOT EXISTS agent_reminders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id   TEXT,
  text       TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_reminders_due ON agent_reminders(sent_at, due_at);

-- Small state the bot keeps, such as the getUpdates offset.
CREATE TABLE IF NOT EXISTS telegram_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
