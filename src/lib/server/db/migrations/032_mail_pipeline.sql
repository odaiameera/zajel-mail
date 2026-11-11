-- One pipeline for new mail, per linked mail account: out-of-office, rules,
-- then Jev, in one pass. It replaces two loops that each kept their own
-- place: the rules scheduler (rules_cursor, by mail address) and the Jev
-- worker (jev_settings.sort_cursor, by account).

-- How far the pipeline has read the account's Inbox (and Junk, while the
-- spam add-on is on): ISO receivedAt. And since when the Inbox has held new
-- mail for the pass (NULL while it doesn't): mail that arrived before the
-- hold was switched on is never held, so nothing already showing
-- disappears.
CREATE TABLE IF NOT EXISTS mail_pipeline (
  account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  cursor     TEXT,
  hold_since INTEGER,                    -- epoch ms
  updated_at INTEGER NOT NULL            -- epoch ms
);

-- Every new message the pipeline has seen, so none is handled twice: not by
-- the short look-back each pass makes, nor after a restart. A message is
-- handled once out-of-office and the rules have had it and it is queued for
-- Jev; one whose pass failed part-way is tried again, up to five times (at
-- most one counted a minute), and then handled without the rules. Rows older
-- than a week are pruned.
CREATE TABLE IF NOT EXISTS mail_arrivals (
  account_id  TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id    TEXT NOT NULL,
  mailbox     TEXT NOT NULL CHECK (mailbox IN ('inbox', 'junk')),
  received_at TEXT NOT NULL,
  seen_at     INTEGER NOT NULL,          -- epoch ms
  handled_at  INTEGER,                   -- epoch ms; NULL until handled
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,               -- epoch ms; when an attempt was last counted
  rules_json  TEXT,                      -- ids of the rules that matched
  PRIMARY KEY (account_id, email_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_arrivals_unhandled ON mail_arrivals (account_id, handled_at, seen_at);
CREATE INDEX IF NOT EXISTS idx_mail_arrivals_seen ON mail_arrivals (seen_at);

-- Each account starts from the earlier of the two old places, so nothing
-- that arrived in between is missed (what is looked at again is safe: rules
-- write only what differs, Jev's queue keeps what it has, out-of-office
-- answers a sender once a day). The rules' place was kept by address:
-- matched exactly, or, for an address no row has exactly, without regard to
-- case. An account with neither gets no row, and starts from its first pass.
-- Timestamps are compared as times, not text: the two were written in
-- different forms ("…:05Z" and "…:05.000Z").
CREATE TEMP TABLE _cursor_032 AS
  SELECT ma.id AS account_id,
    (SELECT rc.last_run FROM rules_cursor rc
      WHERE rc.last_run IS NOT NULL
        AND (rc.user_email = ma.email
             OR (lower(rc.user_email) = lower(ma.email)
                 AND NOT EXISTS (SELECT 1 FROM rules_cursor x WHERE x.user_email = ma.email)))
      ORDER BY julianday(rc.last_run) LIMIT 1) AS rules_at,
    (SELECT js.sort_cursor FROM jev_settings js WHERE js.account_id = ma.id) AS jev_at
  FROM mail_accounts ma;

INSERT INTO mail_pipeline (account_id, cursor, updated_at)
  SELECT account_id,
    CASE
      WHEN rules_at IS NULL THEN jev_at
      WHEN jev_at IS NULL THEN rules_at
      WHEN julianday(rules_at) <= julianday(jev_at) THEN rules_at
      ELSE jev_at
    END,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM _cursor_032
  WHERE rules_at IS NOT NULL OR jev_at IS NOT NULL;

DROP TABLE _cursor_032;

-- Jev's own cursor becomes the moment Jev was switched on: mail received
-- before it is never sent to Jev. Its value is kept (a time at or after the
-- switch, so still a safe boundary); it is no longer moved on by passes.
ALTER TABLE jev_settings RENAME COLUMN sort_cursor TO jev_since;
