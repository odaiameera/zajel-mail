-- Web Push: notifications that reach a device while Zajel Mail isn't open,
-- which is the only way they reach an iPhone at all (Safari delivers
-- notifications to a Home Screen web app through the Push API only).
--
-- One row per browser/device that turned notifications on. The endpoint is
-- the push service URL the browser handed out (Apple, Google, Mozilla); the
-- keys encrypt what is sent to it. A row belongs to the sign-in it was made
-- under, so signing out (or revoking that session) stops a device's lock
-- screen showing mail; the app subscribes again on the next sign-in.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- The server's VAPID key pair, generated on first use. Push services tie
-- every subscription to the public key it was made with, so this must stay
-- put; the private key is stored encrypted like the mail passwords.
CREATE TABLE IF NOT EXISTS push_vapid (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_enc TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
