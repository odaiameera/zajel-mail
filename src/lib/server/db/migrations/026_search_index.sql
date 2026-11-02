-- Semantic search: each linked account's mail embedded by a local model
-- (search/worker.ts), searched beside Stalwart's keyword search. Keyed by the
-- linked account, like Jev, since one login can link several mailboxes.

-- Its Ollama and model, chosen in Settings → Search; NULL uses EMBED_URL and
-- EMBED_MODEL, or the built-in model.
ALTER TABLE ai_settings ADD COLUMN embed_url TEXT;
ALTER TABLE ai_settings ADD COLUMN embed_model TEXT;

CREATE TABLE IF NOT EXISTS search_index (
  account_id    TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  model         TEXT,              -- the model the stored vectors came from; a change starts over
  dimensions    INTEGER,
  email_state   TEXT,              -- JMAP Email state the index has caught up to
  list_cursor   TEXT,              -- receivedAt the listing has reached, newest first
  listed        INTEGER NOT NULL DEFAULT 0,  -- every message has been listed
  list_gen      INTEGER NOT NULL DEFAULT 0,  -- bumped by a full relisting; rows not seen again are gone
  ready         INTEGER NOT NULL DEFAULT 0,  -- everything listed has been embedded once
  last_error    TEXT,
  updated_at    INTEGER NOT NULL
);

-- One row per message: queued, embedded, or given up on.
CREATE TABLE IF NOT EXISTS search_emails (
  account_id   TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id     TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  mailbox_ids  TEXT NOT NULL DEFAULT '',   -- space-separated, for filtering at query time
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  list_gen     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, email_id)
);

CREATE INDEX IF NOT EXISTS idx_search_emails_pending
  ON search_emails (account_id, status, received_at);

-- A message's chunks, each an Int8 vector with its scale.
CREATE TABLE IF NOT EXISTS search_vectors (
  id          INTEGER PRIMARY KEY,
  account_id  TEXT NOT NULL,
  email_id    TEXT NOT NULL,
  chunk       INTEGER NOT NULL,
  scale       REAL NOT NULL,
  vector      BLOB NOT NULL,
  FOREIGN KEY (account_id, email_id) REFERENCES search_emails (account_id, email_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_search_vectors_email ON search_vectors (account_id, email_id);
