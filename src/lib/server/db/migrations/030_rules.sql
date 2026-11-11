-- Rules, one row each, kept by the mail account they belong to: unlinking
-- the account takes them with it. They used to be one JSON list per mail
-- address (user_rules), saved whole from the browser. That table stays, as
-- it was, until a later version drops it, so an upgrade that fails part way
-- loses nothing; the data step data/rules_to_table copies it in here once.
--
-- A rule files what it matches into one place: nowhere ('none'), a folder
-- or a label (by mailbox id), or a folder with a role ('role': Trash,
-- Archive or Junk). attention, note_json and legacy_json are set only by
-- the server, for rules an upgrade had to change (see RuleAttention).
-- The id is the rule's own and is unique within its account.
CREATE TABLE IF NOT EXISTS rules (
  account_id        TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  position          INTEGER NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  name              TEXT NOT NULL,
  logic             TEXT NOT NULL DEFAULT 'allof',   -- 'allof' | 'anyof'
  conditions_json   TEXT NOT NULL DEFAULT '[]',
  target_kind       TEXT NOT NULL DEFAULT 'none',    -- 'none' | 'folder' | 'label' | 'role'
  target_mailbox_id TEXT,                            -- for 'folder' and 'label'
  target_role       TEXT,                            -- for 'role': 'trash' | 'archive' | 'junk'
  mark_read         INTEGER NOT NULL DEFAULT 0,
  star              INTEGER NOT NULL DEFAULT 0,
  stop              INTEGER NOT NULL DEFAULT 0,
  attention         TEXT,
  note_json         TEXT,
  legacy_json       TEXT,
  created_at        INTEGER NOT NULL,                -- ms
  updated_at        INTEGER NOT NULL,                -- ms
  PRIMARY KEY (account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_rules_account_position ON rules(account_id, position);
