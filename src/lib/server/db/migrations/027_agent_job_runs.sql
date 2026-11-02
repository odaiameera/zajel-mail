-- Scheduled jobs that survive a bad run. A failed run is retried after a
-- growing delay instead of waiting a whole period; a digest covers mail since
-- the last run that worked, not the last attempt; and a run cut short by a
-- restart is picked up again once its lease runs out.
ALTER TABLE agent_jobs ADD COLUMN last_ok_at TEXT;                    -- start of the last run that worked
ALTER TABLE agent_jobs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0; -- runs in a row that didn't work, for the retry delay
ALTER TABLE agent_jobs ADD COLUMN running_since TEXT;                 -- set from claim to result; still set after a lease means interrupted

-- A job whose last run worked carries on from it. After a failure the last
-- good run isn't known, so the next digest falls back to the past day.
UPDATE agent_jobs SET last_ok_at = last_run_at WHERE failures = 0;
