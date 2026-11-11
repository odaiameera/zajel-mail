-- Out-of-office replies the app has sent. A row is written before a reply
-- goes out, so a crash mid-send can't lead to a second one, and removed
-- again if the send fails. It is what limits a sender to one reply a day
-- and an account to a few an hour. Rows older than 30 days are pruned.
CREATE TABLE IF NOT EXISTS auto_reply_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,       -- the address answered, lower case
  sent_at    TEXT NOT NULL,       -- ISO time the reply was sent (or began sending)
  email_id   TEXT NOT NULL        -- the message that was answered
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_log_sender ON auto_reply_log(account_id, sender, sent_at);
