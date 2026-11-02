-- Jev sorting new Inbox mail into tabs.

-- The opt-in: whether this account's new mail may be sent to TypeSafe and
-- sorted. Off by default, and only acted on while inbox_tabs is on too.
ALTER TABLE jev_settings ADD COLUMN auto_sort INTEGER NOT NULL DEFAULT 0;

-- ISO receivedAt up to which new Inbox mail has been queued for Jev. Set to
-- "now" when sorting is switched on, so it never reaches back into mail that
-- was already there; cleared when it is switched off.
ALTER TABLE jev_settings ADD COLUMN sort_cursor TEXT;

-- One row per email Jev was asked about. Holds Jev's answer — the
-- probabilities and confidence — and the facts our code sent, never the
-- email's own text, so it can't become a second copy of the mailbox. It is
-- what the "Why is this here?" chip reads, and what retries work from.
CREATE TABLE IF NOT EXISTS jev_decisions (
  account_id     TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id       TEXT NOT NULL,
  -- pending: queued or being retried; done: answered; failed: gave up after
  -- repeated errors; skipped: left the Inbox before Jev got to it.
  status         TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  category       TEXT,      -- Jev's pick
  confidence     REAL,
  applied        TEXT,      -- the tab the email was put in; NULL when left alone
  answers_json   TEXT,      -- Jev's answers: probabilities and confidence
  facts_json     TEXT,      -- the facts sent alongside the email
  model          TEXT,      -- the model that answered, or 'mock'
  input_tokens   INTEGER,
  corrected_to   TEXT,      -- where you moved it afterwards, if you did
  created_at     INTEGER NOT NULL,   -- epoch ms
  decided_at     INTEGER,            -- epoch ms
  PRIMARY KEY (account_id, email_id)
);

CREATE INDEX IF NOT EXISTS idx_jev_decisions_pending
  ON jev_decisions (account_id, status, created_at);

-- Input tokens per account per calendar month (UTC), for the cost shown in
-- Settings. Counts every live call — sorting and previews alike — and no
-- mock ones, which cost nothing.
CREATE TABLE IF NOT EXISTS jev_usage (
  account_id    TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,      -- 'YYYY-MM'
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);
