-- Second factor for password sign-in, and fresh re-checks before risky
-- changes. A passkey counts as a second factor by itself.

-- Authenticator app (TOTP, RFC 6238). The secret is encrypted the same way
-- as linked mail passwords. confirmed_at stays NULL until a first code has
-- been entered, so a half-finished setup never guards a sign-in.
CREATE TABLE IF NOT EXISTS user_totp (
  user_id      TEXT PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  secret_enc   TEXT NOT NULL,
  confirmed_at TEXT,
  last_step    INTEGER NOT NULL DEFAULT 0,  -- newest time step used: a code works once
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time recovery codes for a lost authenticator, stored hashed.
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  PRIMARY KEY (user_id, code_hash)
);

-- A password that checked out, waiting for the second factor. Its id
-- travels in a short-lived httpOnly cookie.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- When this session last proved a second factor (or, with none set up, the
-- password): risky changes require that to be recent.
ALTER TABLE app_sessions ADD COLUMN verified_at TEXT;
