-- Jev learning from you. None of these hold email
-- text: senders, tabs, counts and ids only.

-- "Always put mail from X in this tab." A pin decides the tab before Jev is
-- asked, so a pinned sender's mail never costs a call for its tab. `sender`
-- is a lowercased address, or `@domain` for everyone at a domain; an
-- address pin wins over its domain's.
CREATE TABLE IF NOT EXISTS jev_sender_pins (
  account_id  TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('important', 'updates', 'newsletters', 'promotions')),
  created_at  INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (account_id, sender)
);

-- Every time you move mail between tabs, per sender and tab. Sent to Jev as
-- a fact ("you've moved 3 emails from this sender to Updates"), so it sees
-- your habits without any retraining. Counts, not a log of messages.
CREATE TABLE IF NOT EXISTS jev_sender_moves (
  account_id     TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  sender         TEXT NOT NULL,
  category       TEXT NOT NULL,
  moves          INTEGER NOT NULL DEFAULT 0,
  last_moved_at  INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (account_id, sender, category)
);

-- "This rule shouldn't have fired" on one email, so a rule's misses can be
-- set against its hits when choosing its strictness.
CREATE TABLE IF NOT EXISTS jev_rule_feedback (
  account_id  TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  rule_id     TEXT NOT NULL,
  email_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (account_id, rule_id, email_id)
);

-- Which pin decided an email's tab, when one did ('sam@x.example' or
-- '@x.example'), for the "Why is this here?" chip.
ALTER TABLE jev_decisions ADD COLUMN pinned_by TEXT;
