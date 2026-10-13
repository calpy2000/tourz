-- 2026-10-13: tour clock — per-tour time limit (3 hours for both current tours), started when the
-- team captain finishes the walkthrough, stoppable by the captain at most twice.
-- Safe to run more than once. Apply with:
--   psql -U postgres -h localhost -d tourz -f db/migrations/2026-10-13-tour-clock.sql

ALTER TABLE tours ADD COLUMN IF NOT EXISTS time_limit_minutes INT NOT NULL DEFAULT 180;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'games' AND column_name = 'clock_started_at'
  ) THEN
    ALTER TABLE games ADD COLUMN time_limit_minutes INT NOT NULL DEFAULT 180;
    ALTER TABLE games ADD COLUMN clock_started_at TIMESTAMPTZ;
    ALTER TABLE games ADD COLUMN clock_paused_at TIMESTAMPTZ;
    ALTER TABLE games ADD COLUMN paused_seconds INT NOT NULL DEFAULT 0;
    ALTER TABLE games ADD COLUMN pauses_used INT NOT NULL DEFAULT 0;
    -- Games that already existed were started under the old rule: a 6-hour window running from
    -- activation. Keep them on it rather than retroactively shortening a game already in progress.
    -- Inside this one-time block so a re-run never touches games created under the new rule.
    UPDATE games SET clock_started_at = activated_at, time_limit_minutes = 360;
  END IF;
END $$;

-- expires_at is retired (the deadline is now computed from the clock columns above). Nullable
-- rather than dropped so the old server code can't break if this runs before the new code deploys.
ALTER TABLE games ALTER COLUMN expires_at DROP NOT NULL;
