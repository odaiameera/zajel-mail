-- Sorting the mail already in the Inbox. Queued in jev_decisions like new
-- mail, but marked, because it is judged for its tab only — rules run on new
-- mail, never retroactively — and
-- it waits behind new arrivals so they are never delayed by it.
ALTER TABLE jev_decisions ADD COLUMN backfill INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_jev_decisions_backfill
  ON jev_decisions (account_id, backfill, status, created_at);
