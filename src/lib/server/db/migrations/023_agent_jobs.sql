-- Jobs the agent runs on a schedule: a digest, a tidy-up rule, or an
-- instruction for the agent. Created only from a confirmed card; run with
-- reversible tools only; switched off after repeated failures.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  spec_json      TEXT NOT NULL,     -- what it does: one of the typed kinds in jobs/specs.ts
  schedule_json  TEXT NOT NULL,     -- when: once, hourly, daily, weekdays or weekly
  time_zone      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,              -- NULL once a one-off has run
  last_run_at    TEXT,
  last_result    TEXT,
  failures       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_due ON agent_jobs(enabled, next_run_at);

-- Per login: one switch that pauses every job.
CREATE TABLE IF NOT EXISTS agent_settings (
  user_id     TEXT PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  jobs_paused INTEGER NOT NULL DEFAULT 0
);
