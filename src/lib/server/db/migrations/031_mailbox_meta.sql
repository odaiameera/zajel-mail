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

-- The old rows, matched to their account by address. An account's own rows
-- are those under its exact address: the app read only those. Rows under
-- another spelling of the address are used only for an account with no row
-- of its own in that table at all, and only when no account has that
-- spelling exactly. A row whose address has no account is left behind.
--
-- A display name comes only from label_meta. A folder's name is the mail
-- server's, and folder_meta rows were never removed when a folder was
-- deleted, so a folder row's name could otherwise end up on a label made
-- later with the same id.
CREATE TEMP TABLE _old_031 AS
  SELECT 0 AS src, user_email, mailbox_id, NULLIF(color, '') AS color, NULLIF(icon, '') AS icon,
    NULLIF(display_name, '') AS display_name, created_at, updated_at FROM label_meta
  UNION ALL
  SELECT 1 AS src, user_email, mailbox_id, NULLIF(color, ''), NULLIF(icon, ''), NULL, created_at, updated_at FROM folder_meta;

CREATE TEMP TABLE _meta_031 AS
  SELECT ma.id AS account_id, o.src, o.mailbox_id, o.color, o.icon, o.display_name, o.created_at, o.updated_at
  FROM _old_031 o
  JOIN mail_accounts ma
    ON ma.email = o.user_email
    OR (lower(ma.email) = lower(o.user_email)
        AND NOT EXISTS (SELECT 1 FROM mail_accounts exact WHERE exact.email = o.user_email)
        AND NOT EXISTS (SELECT 1 FROM _old_031 own WHERE own.src = o.src AND own.user_email = ma.email));

-- Where a mailbox has more than one row (a label row and a folder row with
-- the same id), each value comes from the row changed last that has one: an
-- empty colour or icon ("none") never replaces one that is set. A mailbox
-- left with no value at all gets no row.
INSERT INTO mailbox_meta (account_id, mailbox_id, color, icon, display_name, created_at, updated_at)
  SELECT account_id, mailbox_id, color, icon, display_name, created_at, updated_at FROM (
    SELECT k.account_id, k.mailbox_id,
      (SELECT x.color FROM _meta_031 x WHERE x.account_id = k.account_id AND x.mailbox_id = k.mailbox_id AND x.color IS NOT NULL
        ORDER BY x.updated_at DESC, x.src DESC LIMIT 1) AS color,
      (SELECT x.icon FROM _meta_031 x WHERE x.account_id = k.account_id AND x.mailbox_id = k.mailbox_id AND x.icon IS NOT NULL
        ORDER BY x.updated_at DESC, x.src DESC LIMIT 1) AS icon,
      (SELECT x.display_name FROM _meta_031 x WHERE x.account_id = k.account_id AND x.mailbox_id = k.mailbox_id AND x.display_name IS NOT NULL
        ORDER BY x.updated_at DESC LIMIT 1) AS display_name,
      MIN(k.created_at) AS created_at,
      MAX(k.updated_at) AS updated_at
    FROM _meta_031 k
    GROUP BY k.account_id, k.mailbox_id
  )
  WHERE color IS NOT NULL OR icon IS NOT NULL OR display_name IS NOT NULL;

DROP TABLE _meta_031;
DROP TABLE _old_031;
