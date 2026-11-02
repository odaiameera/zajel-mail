-- Jev as the spam layer.

-- Per account: 'off'; 'watch' — Jev's verdict is recorded and shown beside
-- Stalwart's, and nothing moves; 'active' — confident verdicts move mail
-- (to Junk, or rescued from it). Stalwart's own filter stays on throughout.
ALTER TABLE jev_settings ADD COLUMN spam_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (spam_mode IN ('off', 'watch', 'active'));

-- Jev's two spam answers for an email, what Stalwart had decided, what
-- the app did about it, and what you did afterwards.
ALTER TABLE jev_decisions ADD COLUMN spam REAL;              -- P(unsolicited bulk mail or a scam)
ALTER TABLE jev_decisions ADD COLUMN phishing REAL;          -- P(impersonation to get a sign-in, payment or file opened)
ALTER TABLE jev_decisions ADD COLUMN stalwart_spam INTEGER;  -- 1 when Stalwart flagged it or filed it in Junk
-- 'junked' (moved to Junk), 'rescued' (moved out of Junk), 'flagged'
-- (left where it was, with a warning), or NULL. In watch mode, what
-- active mode would have done, prefixed 'would_'.
ALTER TABLE jev_decisions ADD COLUMN spam_action TEXT;
-- 'spam' or 'ham' when you marked it Spam / Not spam afterwards.
ALTER TABLE jev_decisions ADD COLUMN spam_corrected_to TEXT;
