-- Jev settings, one row per linked mail account.
--
-- Per account rather than per login: each mailbox decides on its own
-- whether its Inbox is split into tabs, and — once Jev reads mail — whether
-- that mailbox's content may be sent to TypeSafe at all. Keyed on the linked
-- account row like trash_seen, so unlinking an account drops its row.
--
-- Only the Inbox tabs switch exists so far. The Jev opt-in, rules and spam
-- switches arrive as columns with the phases that act on them, so no switch
-- is stored before anything reads it.
CREATE TABLE IF NOT EXISTS jev_settings (
  account_id  TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  inbox_tabs  INTEGER NOT NULL DEFAULT 0,   -- 0/1: split the Inbox into category tabs
  updated_at  INTEGER NOT NULL              -- epoch ms
);
