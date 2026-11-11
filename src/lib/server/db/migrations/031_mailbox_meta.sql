-- Colour, icon and display name for folders and labels, in one table kept
-- by the mail account they belong to: unlinking the account takes them with
-- it. They used to be two tables keyed by mail address, label_meta and
-- folder_meta, written through three different APIs. Those tables stay, as
-- they were, until a later version drops them, so an upgrade that fails part
-- way loses nothing.
--
-- Every value may be NULL, meaning "none": the folder or label then shows
-- the app's default. An icon of '' was the old way of saying none.
CREATE TABLE IF NOT EXISTS mailbox_meta (
  account_id   TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  mailbox_id   TEXT NOT NULL,
  color        TEXT,
  icon         TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, mailbox_id)
);

-- The old rows, matched to their account by address: exactly first, then,
-- for an address no account has exactly, without regard to case. A row
-- whose address has no account is left behind. Labels go first; where a
-- folder row names the same mailbox, the one changed last wins its colour
-- and icon.
--
-- A display name comes only from label_meta. A folder's name is the mail
-- server's, and folder_meta rows were never removed when a folder was
-- deleted, so a folder row's name could otherwise end up on a label made
-- later with the same id. A folder row with no colour or icon brings nothing.
CREATE TEMP TABLE _meta_031 AS
  SELECT 0 AS src, user_email, mailbox_id, color, icon, display_name, created_at, updated_at FROM label_meta
  UNION ALL
  SELECT 1 AS src, user_email, mailbox_id, color, icon, NULL AS display_name, created_at, updated_at FROM folder_meta
  WHERE NULLIF(color, '') IS NOT NULL OR NULLIF(icon, '') IS NOT NULL;

INSERT INTO mailbox_meta (account_id, mailbox_id, color, icon, display_name, created_at, updated_at)
  SELECT ma.id, m.mailbox_id, NULLIF(m.color, ''), NULLIF(m.icon, ''), NULLIF(m.display_name, ''), m.created_at, m.updated_at
  FROM _meta_031 m
  JOIN mail_accounts ma
    ON ma.email = m.user_email
    OR (lower(ma.email) = lower(m.user_email)
        AND NOT EXISTS (SELECT 1 FROM mail_accounts exact WHERE exact.email = m.user_email))
  WHERE true
  ORDER BY m.src, m.updated_at
ON CONFLICT (account_id, mailbox_id) DO UPDATE SET
  color        = excluded.color,
  icon         = excluded.icon,
  display_name = COALESCE(excluded.display_name, mailbox_meta.display_name),
  updated_at   = excluded.updated_at
WHERE excluded.updated_at >= mailbox_meta.updated_at;

DROP TABLE _meta_031;
