-- The agent's actions. Reversible ones run straight away and are logged
-- here; outward ones (sending, invitations, jobs) wait as a pending action
-- until you confirm them.

-- Outward actions the agent has proposed. The payload is exactly what will
-- run on confirm, re-validated then; the account is the one the agent was
-- working in, whichever account is active when you click.
CREATE TABLE IF NOT EXISTS agent_actions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  conversation_id TEXT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'done', 'cancelled', 'failed', 'expired')),
  result          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  decided_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_user ON agent_actions(user_id, status);

-- Everything the agent did or proposed, wherever it was asked from.
CREATE TABLE IF NOT EXISTS agent_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id  TEXT,
  source      TEXT NOT NULL,              -- chat | telegram | job
  tool        TEXT NOT NULL,
  tier        TEXT NOT NULL,              -- read | self | outward
  summary     TEXT NOT NULL,
  outcome     TEXT NOT NULL,              -- done | proposed | refused | failed
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_user ON agent_audit(user_id, created_at);
