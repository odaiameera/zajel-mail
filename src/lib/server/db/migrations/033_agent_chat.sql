-- Talking to Zajel in the linked Telegram chat, which used to act on nothing
-- typed there, and Zajel's reply drafts.

-- The chat's running conversation with Zajel (ai_conversations.id; /new
-- starts another), the user's clock for it (from the browser that linked
-- the chat, kept current by the web app), and whether an email, an
-- invitation or a deletion Zajel prepares can be confirmed with a button in
-- the chat (Settings → Notifications), rather than only in the web app.
ALTER TABLE telegram_links ADD COLUMN conversation_id TEXT;
ALTER TABLE telegram_links ADD COLUMN time_zone TEXT;
ALTER TABLE telegram_links ADD COLUMN confirm_in_chat INTEGER NOT NULL DEFAULT 1;
ALTER TABLE telegram_link_codes ADD COLUMN time_zone TEXT;

-- Buttons on Zajel's own messages in the chat. Like telegram_buttons, a
-- button carries only this random id, so a press can't be made to name
-- anything else; `ref` is what it acts on: the pending action to confirm or
-- cancel, the scheduled message to take back, the draft to send, or the
-- email to draft a reply to.
CREATE TABLE IF NOT EXISTS telegram_agent_buttons (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('confirm', 'cancel', 'undo_send', 'send_draft', 'draft_reply')),
  ref        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);

-- Which message each of Zajel's reply drafts answers, so a second summary
-- doesn't draft the same reply again while the first is still in Drafts.
CREATE TABLE IF NOT EXISTS agent_reply_drafts (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  email_id   TEXT NOT NULL,
  draft_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, email_id)
);
