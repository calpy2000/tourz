-- 2026-10-18: offline play — every action a phone queues while out of signal carries its own
-- client-generated id, so a re-sent batch (the classic case: the request reached the server but
-- the reply was lost in a dead spot, so the phone sends it again) is recognised and answered from
-- the stored result instead of being applied twice. See POST /api/game/sync in server/index.js.
-- Safe to run more than once. Apply with:
--   psql -U postgres -h localhost -d tourz -f db/migrations/2026-10-18-offline-sync.sql

CREATE TABLE IF NOT EXISTS client_actions (
    id            TEXT PRIMARY KEY,                -- client-generated (crypto.randomUUID)
    team_id       BIGINT NOT NULL REFERENCES teams(id),
    player_id     BIGINT REFERENCES players(id),
    action_type   TEXT NOT NULL,
    client_time   TIMESTAMPTZ,                     -- when the player tapped, as the phone reported it
    applied_time  TIMESTAMPTZ,                     -- the time it was judged at (client_time clamped)
    status        INT,                             -- HTTP-style outcome; NULL while still being processed
    result        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_actions_team_idx ON client_actions(team_id);
