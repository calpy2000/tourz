-- TOURZ database schema — draft 1
-- Two clearly separated sections: CONTENT (static, admin-authored) and INSTANCE (dynamic, per-game).
-- This separation is the core architectural bet: adding a new city/tour later should mean
-- new rows in the CONTENT section only — the INSTANCE section and game engine never change.

-- =========================================================================
-- CONTENT — static, rarely changes, authored as JSON + imported (see project memory)
-- =========================================================================

CREATE TABLE cities (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tours (
    id               BIGSERIAL PRIMARY KEY,
    city_id          BIGINT NOT NULL REFERENCES cities(id),
    name             TEXT NOT NULL,
    total_landmarks  INT NOT NULL,  -- the PLANNED final tile count (incl. the start landmark),
                                     -- not just how many landmarks are authored so far — lets the
                                     -- Home tile grid draw placeholder "?" tiles for the rest
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The ordered walking route. sequence_order is the secret the whole game hinges on —
-- the API must NEVER return more than one landmark's row (the team's current one) to a client.
CREATE TABLE landmarks (
    id                    BIGSERIAL PRIMARY KEY,
    tour_id               BIGINT NOT NULL REFERENCES tours(id),
    sequence_order        INT NOT NULL,
    title                 TEXT NOT NULL,
    address               TEXT NOT NULL,
    latitude              NUMERIC(9,6) NOT NULL,
    longitude             NUMERIC(9,6) NOT NULL,
    about_landmark_label  TEXT,      -- e.g. "About the statue" / "About the building"
    about_landmark_text   TEXT,      -- facts about the physical landmark itself
    about_subject_label   TEXT,      -- e.g. "About William Pitt the Younger" / "About its history"
    about_subject_text    TEXT,      -- facts about the person/history behind the landmark
    interesting_fact      TEXT,      -- one standout callout shown at the end of about_subject_text
    external_link         TEXT,      -- e.g. Wikipedia, same idea as sites.external_link
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tour_id, sequence_order)
);
-- title/address/latitude/longitude double as the "reveal" content for the clue step —
-- no separate reveal table needed, the API just returns these fields when reveal is requested.
-- about_*/interesting_fact/external_link exist so a completed landmark can render as a detail
-- page (image, two fact sections, a standout fact, a link out) once solved — deliberately NOT
-- merged into the sites table (a landmark is gameplay-critical: it owns sequence_order and the
-- clue/puzzle/quiz rows below; a site is purely decorative content, never part of the game loop).
-- The map view combines both at the presentation layer only.

CREATE TABLE landmark_images (
    id           BIGSERIAL PRIMARY KEY,
    landmark_id  BIGINT NOT NULL REFERENCES landmarks(id),
    image_path   TEXT NOT NULL,       -- static file path/URL, compressed, checked in with content
    sort_order   INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 1: the clue to find the landmark. One clue per landmark (1:1).
CREATE TABLE clues (
    id          BIGSERIAL PRIMARY KEY,
    landmark_id BIGINT NOT NULL UNIQUE REFERENCES landmarks(id),
    type        TEXT NOT NULL,        -- e.g. 'directions', 'grid_reference', 'cryptic', 'anagram'
                                       -- authoring label only — every clue type stores as plain text
    clue_text   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Progressive hints for a clue — variable length per landmark (0, 1, many).
CREATE TABLE clue_hints (
    id          BIGSERIAL PRIMARY KEY,
    clue_id     BIGINT NOT NULL REFERENCES clues(id),
    hint_order  INT NOT NULL,
    hint_text   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (clue_id, hint_order)
);

-- Step 2: the on-site puzzle. One per landmark (1:1). Answer-checking type varies per puzzle
-- (exact numeric, fuzzy text, multiple choice, ...) so the answer shape lives in a flexible
-- JSON payload rather than fixed columns — validation logic lives in the app, not the DB.
CREATE TABLE puzzles (
    id              BIGSERIAL PRIMARY KEY,
    landmark_id     BIGINT NOT NULL UNIQUE REFERENCES landmarks(id),
    type            TEXT NOT NULL,      -- e.g. 'fuzzy_text', 'exact_numeric', 'multiple_choice'
    question_text   TEXT NOT NULL,
    answer_payload  JSONB NOT NULL,     -- shape depends on `type`
    explanation     TEXT,               -- shown in the "Why?" expand once answered, either way
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 3: the landmark quiz — actually a quiz about the walk TO the landmark, not just the
-- destination itself. Many questions per landmark, type deliberately open-ended (multiple
-- choice today, anagram/maths/cryptic tomorrow) — same flexible-payload pattern as puzzles.
CREATE TABLE quiz_questions (
    id              BIGSERIAL PRIMARY KEY,
    landmark_id     BIGINT NOT NULL REFERENCES landmarks(id),
    sequence_order  INT NOT NULL,
    type            TEXT NOT NULL,
    question_text   TEXT NOT NULL,
    answer_payload  JSONB NOT NULL,
    explanation     TEXT,                       -- shown in the "Why?" expand once answered, either way
    points          INT NOT NULL DEFAULT 10,   -- placeholder value — exact scoring TBD (quiz points are
                                                 -- now actually a lump sum on completion, see quizPoints() —
                                                 -- this column is legacy/unused for scoring, kept for reference)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (landmark_id, sequence_order)
);

-- Curated map points of interest ("Interests" layer in the Map view). Deliberately duplicated
-- per tour rather than a join table, by choice (simplicity over normalisation, given small
-- manually-curated content volume). Content shape deliberately mirrors landmarks' about/subject/
-- interesting_fact columns (not a single `description`) so both can share one detail page
-- component client-side — see client/src/components/PointOfInterestDetail.jsx.
CREATE TABLE sites (
    id                    BIGSERIAL PRIMARY KEY,
    tour_id               BIGINT NOT NULL REFERENCES tours(id),
    title                 TEXT NOT NULL,
    address               TEXT NOT NULL,
    type                  TEXT NOT NULL,       -- e.g. 'statue', 'famous_person', 'building'
    latitude              NUMERIC(9,6) NOT NULL,
    longitude             NUMERIC(9,6) NOT NULL,
    about_site_label      TEXT,
    about_site_text       TEXT,
    about_subject_label   TEXT,
    about_subject_text    TEXT,
    interesting_fact      TEXT,
    image_path            TEXT,
    external_link         TEXT,                -- e.g. Wikipedia
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Live/dynamic POIs (restaurants, pubs, toilets) are NOT stored here — fetched at render time
-- from Google Maps via the backend. No table needed for those.

-- =========================================================================
-- INSTANCE — dynamic, created per purchase/game
-- =========================================================================

-- The purchased credential. 30-day window to activate; single-use (one game per code).
-- `code` is the actual secret — generate as a long random string in application code, not a
-- sequential/guessable value, since it doubles as the only auth mechanism (no passwords).
CREATE TABLE game_codes (
    id            BIGSERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    tour_id       BIGINT NOT NULL REFERENCES tours(id),
    max_players   INT NOT NULL DEFAULT 4,     -- base slots from purchase; increases via later slot purchases
    purchased_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,       -- purchased_at + 30 days, set by application
    status        TEXT NOT NULL DEFAULT 'unused'
                    CHECK (status IN ('unused', 'activated', 'expired')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Payment/purchase audit detail (Stripe session IDs, slot-purchase history) deliberately
-- left out of this pass — belongs to the purchase API work, not the game engine schema.

-- The live 6-hour session, created only at activation.
CREATE TABLE games (
    id             BIGSERIAL PRIMARY KEY,
    game_code_id   BIGINT NOT NULL UNIQUE REFERENCES game_codes(id),
    activated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,      -- activated_at + 6 hours, set by application
    status         TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'expired')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The roster + running state. current_landmark_sequence and total_score are a cached/derived
-- "current state" for fast reads — progress_events below is the source of truth they're derived from.
CREATE TABLE teams (
    id                       BIGSERIAL PRIMARY KEY,
    game_id                  BIGINT NOT NULL UNIQUE REFERENCES games(id),
    name                     TEXT,
    current_landmark_sequence INT NOT NULL DEFAULT 1,
    total_score              INT NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE players (
    id             BIGSERIAL PRIMARY KEY,
    team_id        BIGINT NOT NULL REFERENCES teams(id),
    name           TEXT NOT NULL,
    avatar         TEXT,
    is_captain     BOOLEAN NOT NULL DEFAULT false,
    session_token  TEXT NOT NULL UNIQUE,   -- random, unguessable — proves identity across reconnects.
                                            -- NOT the same as a sequential id; generate with a CSPRNG.
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only ledger of everything scoring-relevant that happens: hints requested, reveals,
-- puzzle/quiz answers, landmark completions. This is the offline/replay source of truth —
-- a reconnecting client asks "give me everything after id N" and catches up. `id` itself
-- (globally monotonic) serves as the sequence cursor, so no separate sequence column is needed.
-- event_type is left as free text rather than a CHECK-constrained enum since the exact set of
-- event types will keep evolving alongside the scoring design.
CREATE TABLE progress_events (
    id            BIGSERIAL PRIMARY KEY,
    team_id       BIGINT NOT NULL REFERENCES teams(id),
    landmark_id   BIGINT NOT NULL REFERENCES landmarks(id),
    player_id     BIGINT REFERENCES players(id),   -- who triggered it (captain-only, enforced in app)
    event_type    TEXT NOT NULL,
    points_delta  INT NOT NULL DEFAULT 0,
    payload       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The team message feed (a log, not two-way chat). Same replay pattern as progress_events —
-- `id` is the cursor a reconnecting client uses to fetch what it missed.
CREATE TABLE messages (
    id          BIGSERIAL PRIMARY KEY,
    team_id     BIGINT NOT NULL REFERENCES teams(id),
    player_id   BIGINT REFERENCES players(id),      -- null for system-generated messages
    type        TEXT NOT NULL,                      -- e.g. 'system', 'player_joined'
    text        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Post-MVP feature (GPS proximity), schema included now per the "cheap now, painful to
-- retrofit" principle. Unused until that feature is built.
CREATE TABLE location_pings (
    id           BIGSERIAL PRIMARY KEY,
    player_id    BIGINT NOT NULL REFERENCES players(id),
    latitude     NUMERIC(9,6) NOT NULL,
    longitude    NUMERIC(9,6) NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
