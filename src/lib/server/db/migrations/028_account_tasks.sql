-- One-time jobs that need a mail account's own credentials, so they can't
-- run from the migration runner: they run on the account's next rules run
-- instead. A row means the task is done for that account and never runs
-- again; a task that failed has no row and is tried on the next run.
CREATE TABLE IF NOT EXISTS account_tasks (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  done_at    TEXT NOT NULL,
  PRIMARY KEY (account_id, name)
);
