-- Urgent-mail alerts on their way to Telegram. An alert is written here
-- before it is sent and stays until Telegram accepts it, so a failed send,
-- a restart or the hourly cap delays it instead of losing it. The message
-- is cleared once sent or given up; the row stays a week so the same email
-- is never alerted twice.
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'urgent',  -- urgent | notice (no email buttons, not capped)
  user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id        TEXT NOT NULL,
  html            TEXT,               -- the message as it will be sent; NULL once done
  summary         TEXT,               -- for the activity log; NULL once done
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  done_at         TEXT,
  outcome         TEXT,               -- sent | refused | expired | dropped
  UNIQUE (account_id, email_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_outbox_due ON telegram_outbox(done_at, next_attempt_at);

-- A reminder being sent is claimed for a couple of minutes rather than
-- marked sent, so one whose send died with the process is tried again.
ALTER TABLE agent_reminders ADD COLUMN claimed_at TEXT;
