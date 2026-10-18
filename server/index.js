// Thin-slice gameplay API — enough to walk the real clue -> puzzle -> quiz loop against
// seeded content, with one auto-created dev team. No activation/purchase/captain/sockets yet.
//
// Scoring is a placeholder (documented inline) — the real formula is still an open design
// question. Fuzzy-text answer matching is also placeholder (lowercase/trim only) — the real
// fuzzy-matching approach hasn't been decided yet either.

// path: __dirname (not cwd-relative) - dotenv otherwise silently no-ops when this process is
// started as `node server/index.js` from the project root (cwd = TOURZ root, no .env there;
// the real one lives in server/.env), leaving GOOGLE_PLACES_API_KEY undefined and every Google
// Places/Routes call failing with a misleading "API key not valid" error - see
// [[feedback-dotenv-cwd-relative-path]].
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
// 10mb (not the default 100kb) — the certificate-email route posts a rasterized PNG as a base64
// data URL, which runs several hundred KB even for a small card.
app.use(express.json({ limit: '10mb' }));
app.use('/content-photos', express.static(path.join(__dirname, 'content-photos')));
app.use('/content-audio', express.static(path.join(__dirname, 'content-audio')));

// Unauthenticated, no DB query — pinged every few minutes by the Cloudflare Worker's cron
// trigger (see client/worker.js) purely to keep this Render free-tier service from spinning down
// after 15 minutes idle, which otherwise cold-starts (30-60s+) on a real player's next request.
app.get('/api/health', (req, res) => res.json({ ok: true }));

const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

const db = process.env.DATABASE_URL
  ? new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Client({ host: 'localhost', port: 5432, user: 'postgres', database: 'tourz' });

// Puzzle-solve scoring — re-amended 2026-08-24: a wrong answer is always 0, full stop — no
// partial credit for how well the landmark was found. A correct answer starts at 1 point and
// gets a bonus for finding it with fewer hints (or none at all).
function puzzlePoints(hintsUsed, revealUsed, correct) {
  if (!correct) return 0;
  if (revealUsed) return 1;
  return Math.max(1, 5 - hintsUsed);
}

// Quiz scoring — amended 2026-08-24: no per-question points anymore. Points are a lump sum
// awarded once all 4 questions are answered, based on how many were correct.
function quizPoints(correctCount) {
  return { 4: 5, 3: 3, 2: 2, 1: 1, 0: 0 }[correctCount] ?? 0;
}

// anagram: single question per landmark, same lump-sum-on-completion shape as five_right, but
// scored as a flat pass/fail (no partial credit for a near-miss letter order) — matches the max
// score of the other quiz formats.
const ANAGRAM_POINTS = 5;

// The current landmark's identity is "revealed" the moment its puzzle is solved — same gate
// already used by GET /api/game/landmark/:sequenceOrder to allow viewing it before the quiz is
// done. Home (tile grid) and the Map view need this same signal, separately from
// team.current_landmark_sequence, which only advances after the quiz is completed AND the
// "Head to next landmark" button is tapped — deliberately not the same moment as "found".
async function currentRevealedLandmark(team, tourId) {
  const { rows: [landmark] } = await db.query(
    `SELECT l.sequence_order, l.title, l.latitude, l.longitude,
            (SELECT image_path FROM landmark_images WHERE landmark_id = l.id ORDER BY sort_order LIMIT 1) AS image_path
     FROM landmarks l
     WHERE l.tour_id = $1 AND l.sequence_order = $2
       AND EXISTS (
         SELECT 1 FROM progress_events
         WHERE team_id = $3 AND landmark_id = l.id AND event_type = 'puzzle_solved'
       )`,
    [tourId, team.current_landmark_sequence, team.id]
  );
  return landmark || null;
}

// The first landmark that actually has a puzzle — skips any start/informational landmark (no
// gameplay, e.g. sequence_order 1) so a newly-activated team begins on the first landmark to
// actually solve. Shared by /api/register (new team) and the dev endpoints (per-team reset).
async function firstPlayableSequence(tourId) {
  const { rows: [{ min_sequence }] } = await db.query(
    `SELECT MIN(l.sequence_order) AS min_sequence
     FROM landmarks l JOIN puzzles p ON p.landmark_id = l.id
     WHERE l.tour_id = $1`,
    [tourId]
  );
  return min_sequence;
}

// Resolves the calling player + their team from the X-Session-Token header — this is the API's
// only notion of "who is asking". Replaces the old single hardcoded dev team: every request now
// proves identity with the unguessable token issued at /api/register, per this project's
// standing rule that team/captain identity must be enforced server-side, never trusted from the
// client. Writes the 401 itself (so route handlers can just `if (!session) return;`).
async function resolveSession(req, res) {
  const token = req.header('X-Session-Token');
  if (!token) {
    res.status(401).json({ error: 'Missing session.' });
    return null;
  }
  const { rows: [player] } = await db.query('SELECT * FROM players WHERE session_token = $1', [token]);
  if (!player) {
    res.status(401).json({ error: 'Invalid session.' });
    return null;
  }
  const { rows: [team] } = await db.query('SELECT * FROM teams WHERE id = $1', [player.team_id]);
  return { player, team };
}

// Captain-only gate for the scoring/progress-mutating routes (hint, reveal, puzzle/quiz answer,
// advance) — only the team captain may act, enforced here rather than trusted from the client.
function requireCaptain(player, res) {
  if (!player.is_captain) {
    res.status(403).json({ error: 'Only your team captain can do this.' });
    return false;
  }
  return true;
}

// The tour clock. Counts only running time: nothing before the captain starts it (by finishing
// the guided walkthrough), and nothing while the captain has it stopped. Computed on every read
// from games' clock columns rather than stored as a deadline, so stop/restart never rewrites one.
// Once every landmark is completed the clock freezes at that moment — a finished team can't run
// out of time afterwards, however long they take to tap through to their certificate.
const MAX_CLOCK_STOPS = 2;

// Whether GET /api/game/current carries the `_dev` block (the current puzzle answer + every quiz
// answer, logged to the browser console for testing). Defaults to on for the local server (no
// DATABASE_URL) and off in production; set EXPOSE_DEV_ANSWERS=true|false to override either way.
const EXPOSE_DEV_ANSWERS = process.env.EXPOSE_DEV_ANSWERS
  ? process.env.EXPOSE_DEV_ANSWERS === 'true'
  : !process.env.DATABASE_URL;

// `at` (default now) is the moment being judged — an action synced from a phone that was out of
// signal is judged at the time it was actually tapped (see POST /api/game/sync), so an answer given
// a minute before time ran out still counts even though it reaches the server after. A stop that
// began after `at` doesn't count as paused at `at`.
function clockState(game, allCompleted, completedAt, at = new Date()) {
  const limitSeconds = game.time_limit_minutes * 60;
  const startedAt = game.clock_started_at && new Date(game.clock_started_at);
  if (!startedAt || startedAt > at) {
    return { started: false, paused: false, timeUp: false, elapsedSeconds: 0, remainingSeconds: limitSeconds, limitSeconds };
  }
  const pausedAt = game.clock_paused_at && new Date(game.clock_paused_at) <= at ? new Date(game.clock_paused_at) : null;
  const endPoint = allCompleted && completedAt && new Date(completedAt) <= at ? new Date(completedAt) : pausedAt || at;
  const elapsed = Math.max(0, Math.floor((endPoint - startedAt) / 1000) - game.paused_seconds);
  const remaining = Math.max(0, limitSeconds - elapsed);
  return {
    started: true,
    paused: Boolean(pausedAt),
    timeUp: !allCompleted && remaining <= 0,
    elapsedSeconds: Math.min(elapsed, limitSeconds),
    remainingSeconds: remaining,
    limitSeconds,
  };
}

// Everything clock-related for one team in one place: the game row, the computed clock, and
// landmark completion ("12/14") — which the clock needs too, since finishing stops it.
// playableCount counts landmarks that actually have a puzzle, i.e. excludes the start landmark,
// matching the "Found x/14" footer pill.
async function gameClockFor(team, at = new Date()) {
  const { rows: [game] } = await db.query('SELECT * FROM games WHERE id = $1', [team.game_id]);
  const { rows: [counts] } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM landmarks l JOIN puzzles p ON p.landmark_id = l.id
        JOIN game_codes gc ON gc.tour_id = l.tour_id WHERE gc.id = $2) AS playable_count,
       (SELECT COUNT(*) FROM progress_events WHERE team_id = $1 AND event_type = 'landmark_completed') AS completed_count,
       (SELECT MAX(created_at) FROM progress_events WHERE team_id = $1 AND event_type = 'landmark_completed') AS last_completed_at`,
    [team.id, game.game_code_id]
  );
  const playableCount = Number(counts.playable_count);
  const completedCount = Number(counts.completed_count);
  const allCompleted = playableCount > 0 && completedCount >= playableCount;
  return {
    game,
    clock: clockState(game, allCompleted, counts.last_completed_at, at),
    allCompleted,
    completedCount,
    playableCount,
    lastCompletedAt: counts.last_completed_at,
  };
}

// The clock starts the moment the team's CURRENT captain has finished the guided walkthrough —
// called from every place that can make that true (the captain finishing it, a captain handoff to
// someone who already has, and the clock poll itself as a self-heal). Idempotent and atomic: the
// WHERE clause only ever lets the first caller set clock_started_at.
async function maybeStartClock(team, at = new Date()) {
  await db.query(
    `UPDATE games SET clock_started_at = $3
     WHERE id = $1 AND clock_started_at IS NULL
       AND EXISTS (SELECT 1 FROM players WHERE team_id = $2 AND is_captain AND coach_complete)`,
    [team.game_id, team.id, at]
  );
}

// Gate for every scoring/progress-mutating route: no play before the clock starts, while it's
// stopped, or once time is up. Enforced here, not just by the frozen screen client-side, per this
// project's rule that anything with real value is enforced server-side. A team that has completed
// every landmark is let through (the clock has frozen at completion) so the final "Head to next
// landmark" tap still works. 423 Locked, so the client can tell this apart from a real error.
async function clockBlockError(team, at = new Date()) {
  const { clock, allCompleted } = await gameClockFor(team, at);
  if (allCompleted) return null;
  if (!clock.started) return "The tour clock hasn't started yet — it starts when your captain finishes the app walkthrough.";
  if (clock.timeUp) return "Time's up — your tour has ended.";
  if (clock.paused) return 'The clock is stopped — your captain needs to restart it before you can carry on.';
  return null;
}

// Shape of GET /api/game/clock (and the stop/restart responses) — the one payload the client's
// GameClockProvider runs everything off: footer countdown, frozen screen, banners, warnings, the
// time's-up popup and the Help menu's stop/restart items.
async function clockPayload(player, team) {
  const { game, clock, allCompleted, completedCount, playableCount } = await gameClockFor(team);
  const { rows: [captain] } = await db.query('SELECT name FROM players WHERE team_id = $1 AND is_captain', [team.id]);
  const { rows: [freshTeam] } = await db.query('SELECT total_score FROM teams WHERE id = $1', [team.id]);
  return {
    gameId: game.id,
    started: clock.started,
    paused: clock.paused,
    timeUp: clock.timeUp,
    tourComplete: allCompleted,
    remainingSeconds: clock.remainingSeconds,
    limitSeconds: clock.limitSeconds,
    pausesUsed: game.pauses_used,
    maxStops: MAX_CLOCK_STOPS,
    isCaptain: player.is_captain,
    captainName: captain ? captain.name : null,
    coachComplete: player.coach_complete,
    landmarksCompleted: completedCount,
    totalLandmarks: playableCount,
    totalScore: freshTeam.total_score,
  };
}

async function getCurrentLandmark(team) {
  const { rows: [landmark] } = await db.query(
    `SELECT l.*, c.id AS clue_id, c.type AS clue_type, c.clue_text,
            p.id AS puzzle_id, p.type AS puzzle_type, p.question_text AS puzzle_question, p.answer_payload AS puzzle_answer,
            p.explanation AS puzzle_explanation
     FROM landmarks l
     JOIN clues c ON c.landmark_id = l.id
     JOIN puzzles p ON p.landmark_id = l.id
     JOIN tours t ON t.id = l.tour_id
     JOIN game_codes gc ON gc.tour_id = t.id
     JOIN games g ON g.game_code_id = gc.id
     WHERE g.id = $1 AND l.sequence_order = $2`,
    [team.game_id, team.current_landmark_sequence]
  );
  return landmark;
}

async function eventsFor(teamId, landmarkId) {
  const { rows } = await db.query(
    `SELECT * FROM progress_events WHERE team_id = $1 AND landmark_id = $2 ORDER BY id`,
    [teamId, landmarkId]
  );
  return rows;
}

function normalize(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Deterministic shuffle for five_right tile display order — seeded by team+question so every poll
// (and every team member's device) sees the same random-looking arrangement for the lifetime of
// that team's playthrough, but a different arrangement than any other team gets. Tile identity for
// picking/scoring is always by `tile.id`, never by array position, so shuffling this is display-only.
// FNV-1a seed into a mulberry32-style generator — deterministic per seed string. Also drives
// sealJson's keystream; the client mirror (client/src/offline/seal.js) must produce the same output.
function seededRandom(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return function rand() {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(array, seedStr) {
  const rand = seededRandom(seedStr);
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    ;[result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function readableAnswer(type, payload) {
  if (type === 'exact_numeric') return payload.answer;
  if (type === 'fuzzy_text') return payload.accepted[0];
  if (type === 'multiple_choice') return payload.correct;
  return JSON.stringify(payload);
}

// Shared shape for "what does this player's registration status look like right now" — used by
// both the response of POST /api/register and GET /api/game/session (the latter lets the welcome
// page re-fetch live state, e.g. after a refresh, or once a captain registers after a member).
async function registrationStatus(player, team) {
  const { rows: teamPlayers } = await db.query(
    'SELECT id, name, is_captain, joined_at FROM players WHERE team_id = $1 ORDER BY joined_at',
    [team.id]
  );
  const { rows: [gameCode] } = await db.query(
    `SELECT gc.max_players, g.time_limit_minutes FROM game_codes gc JOIN games g ON g.game_code_id = gc.id WHERE g.id = $1`,
    [team.game_id]
  );
  const captain = teamPlayers.find((p) => p.is_captain);
  const registrationNumber = teamPlayers.findIndex((p) => p.id === player.id) + 1;

  return {
    sessionToken: player.session_token,
    player: { id: player.id, name: player.name, avatar: player.avatar, isCaptain: player.is_captain },
    team: { id: team.id, name: team.name },
    registrationNumber,
    maxPlayers: gameCode.max_players,
    captainName: captain ? captain.name : null,
    timeLimitMinutes: gameCode.time_limit_minutes,
  };
}

// POST /api/register — the only unauthenticated endpoint besides the health of the server itself.
// Activates the game code on its first use (creates games + teams rows), or joins the existing
// team on every use after that. See project-architecture memory: activation/captain/expiry rules
// must live here, server-side — a client can't be trusted to self-police any of this.
app.post('/api/register', async (req, res) => {
  const { code, name, avatar, role } = req.body;
  if (!code || !name || !avatar || !['captain', 'member'].includes(role)) {
    return res.status(400).json({ error: 'Missing or invalid registration details.' });
  }

  const { rows: [gameCode] } = await db.query('SELECT * FROM game_codes WHERE code = $1', [code.trim()]);
  if (!gameCode) return res.status(404).json({ error: 'That game code was not recognised.' });
  if (gameCode.status === 'expired') return res.status(400).json({ error: 'This game code has expired.' });

  let team;
  if (gameCode.status === 'unused') {
    // Activation does NOT start the tour clock — that waits for the captain to finish the guided
    // walkthrough (see maybeStartClock). The tour's time limit is copied onto the game here.
    const { rows: [game] } = await db.query(
      `INSERT INTO games (game_code_id, time_limit_minutes)
       VALUES ($1, (SELECT time_limit_minutes FROM tours WHERE id = $2)) RETURNING *`,
      [gameCode.id, gameCode.tour_id]
    );
    const minSequence = await firstPlayableSequence(gameCode.tour_id);
    const { rows: [newTeam] } = await db.query(
      `INSERT INTO teams (game_id, current_landmark_sequence) VALUES ($1, $2) RETURNING *`,
      [game.id, minSequence]
    );
    await db.query(`UPDATE game_codes SET status = 'activated' WHERE id = $1`, [gameCode.id]);
    team = newTeam;
  } else {
    const { rows: [game] } = await db.query('SELECT * FROM games WHERE game_code_id = $1', [gameCode.id]);
    const { rows: [existingTeam] } = await db.query('SELECT * FROM teams WHERE game_id = $1', [game.id]);
    if ((await gameClockFor(existingTeam)).clock.timeUp) {
      return res.status(400).json({ error: 'This game has finished — its time limit is up.' });
    }
    team = existingTeam;
  }

  const { rows: teamPlayers } = await db.query('SELECT * FROM players WHERE team_id = $1', [team.id]);
  if (teamPlayers.length >= gameCode.max_players) {
    return res.status(400).json({ error: 'This team is already full.' });
  }
  if (role === 'captain' && teamPlayers.some((p) => p.is_captain)) {
    return res.status(400).json({ error: 'A team captain has already registered for this team.' });
  }

  const sessionToken = crypto.randomBytes(24).toString('hex');
  const { rows: [player] } = await db.query(
    `INSERT INTO players (team_id, name, avatar, is_captain, session_token) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [team.id, name.trim(), avatar, role === 'captain', sessionToken]
  );

  res.json(await registrationStatus(player, team));
});

// GET /api/game/session — live registration status for the calling session, used by the welcome
// page so a browser refresh mid-flow (or a captain registering after a member) still shows the
// current, correct state rather than whatever was true at the moment of /api/register.
app.get('/api/game/session', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  res.json(await registrationStatus(session.player, session.team));
});

// POST /api/game/team/name — only the first registrant sets this, exactly once (the welcome
// page hides/disables the field once teams.name is already set).
app.post('/api/game/team/name', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;
  const { name } = req.body;
  if (team.name) return res.status(400).json({ error: 'This team already has a name.' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Enter a team name.' });

  const { rows: [updated] } = await db.query('UPDATE teams SET name = $1 WHERE id = $2 RETURNING name', [name.trim(), team.id]);
  res.json({ name: updated.name });
});

// GET /api/game/team/players — captain-only: the teammate roster shown in the "change team
// captain" picker (HelpMenu -> ChangeCaptainPopup). Excludes the calling captain themselves,
// since they can't hand the role to themselves.
app.get('/api/game/team/players', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;

  const { rows } = await db.query(
    'SELECT id, name, avatar FROM players WHERE team_id = $1 AND id != $2 ORDER BY joined_at',
    [team.id, player.id]
  );
  res.json({ players: rows });
});

// POST /api/game/team/captain — captain-only: hands the captaincy to another team member.
// Session tokens never change — is_captain is checked fresh by requireCaptain on every
// captain-gated request, so flipping it here takes effect immediately for both players on their
// next action, with no need to reissue or invalidate anything. The OTHER device's cached
// isCaptain flag catches up next time its own gameplay poll sees the new value on
// GET /api/game/current (see PlayPage.jsx's captain-sync effect).
app.post('/api/game/team/captain', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;

  const newCaptainId = Number(req.body.newCaptainId);
  const { rows: [newCaptain] } = await db.query(
    'SELECT * FROM players WHERE id = $1 AND team_id = $2', [newCaptainId, team.id]
  );
  if (!newCaptain) return res.status(400).json({ error: 'That player is not on your team.' });
  if (newCaptain.id === player.id) return res.status(400).json({ error: 'You are already the captain.' });
  // Only the captain can restart a stopped clock — handing the role over mid-stop would leave the
  // team frozen behind a banner naming the wrong person. Nor before the clock has started — the
  // captain is still reading the instructions / doing the walkthrough, which is what starts it.
  const { clock } = await gameClockFor(team);
  if (!clock.started) {
    return res.status(423).json({ error: "You can't change captain until the tour clock has started." });
  }
  if (clock.paused) {
    return res.status(423).json({ error: "You can't change captain while the clock is stopped — restart it first." });
  }

  await db.query('UPDATE players SET is_captain = false WHERE id = $1', [player.id]);
  await db.query('UPDATE players SET is_captain = true WHERE id = $1', [newCaptain.id]);

  res.json({ newCaptainId: newCaptain.id, newCaptainName: newCaptain.name });
});

// GET /api/game/home — header stats + the tile/list view's solved-landmark data.
// Never includes anything about the current or future landmarks beyond "you have one in progress".
app.get('/api/game/home', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const { rows: [tourRow] } = await db.query(
    `SELECT t.id, t.name, t.tour_code, t.total_landmarks, g.activated_at, g.clock_started_at, g.time_limit_minutes
     FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );

  // JOIN puzzles — excludes the start/informational landmark (no gameplay, so no points
  // possible) from the max-score total. total_landmarks (the planned tile count) comes from
  // tourRow, not a count of authored rows — see the response below.
  const { rows: [totals] } = await db.query(
    `SELECT SUM(30 + COALESCE(q.points_sum, 0)) AS max_score
     FROM landmarks l
     JOIN puzzles p ON p.landmark_id = l.id
     LEFT JOIN (
       SELECT landmark_id, SUM(points) AS points_sum FROM quiz_questions GROUP BY landmark_id
     ) q ON q.landmark_id = l.id
     WHERE l.tour_id = $1`,
    [tourRow.id]
  );

  const { rows: solved } = await db.query(
    `SELECT l.id, l.sequence_order, l.title, l.address,
            (SELECT image_path FROM landmark_images WHERE landmark_id = l.id ORDER BY sort_order LIMIT 1) AS image_path
     FROM landmarks l
     WHERE l.tour_id = $1 AND l.sequence_order < $2
     ORDER BY l.sequence_order`,
    [tourRow.id, team.current_landmark_sequence]
  );

  const { rows: completedEvents } = await db.query(
    `SELECT landmark_id, created_at FROM progress_events
     WHERE team_id = $1 AND event_type = 'landmark_completed' ORDER BY created_at`,
    [team.id]
  );
  const { rows: pointsRows } = await db.query(
    `SELECT landmark_id, SUM(points_delta) AS points FROM progress_events WHERE team_id = $1 GROUP BY landmark_id`,
    [team.id]
  );
  const pointsByLandmark = Object.fromEntries(pointsRows.map((r) => [r.landmark_id, Number(r.points)]));

  const revealed = await currentRevealedLandmark(team, tourRow.id);

  let previousTime = new Date(tourRow.clock_started_at || tourRow.activated_at);
  const landmarks = solved.map((l) => {
    const completedEvent = completedEvents.find((e) => e.landmark_id === l.id);
    const completedAt = completedEvent ? new Date(completedEvent.created_at) : null;
    const secondsTaken = completedAt ? Math.round((completedAt - previousTime) / 1000) : null;
    if (completedAt) previousTime = completedAt;
    return {
      sequenceOrder: l.sequence_order,
      title: l.title,
      address: l.address,
      imagePath: l.image_path,
      points: pointsByLandmark[l.id] || 0,
      secondsTaken,
    };
  });

  res.json({
    teamName: team.name,
    tourName: tourRow.name,
    tourCode: tourRow.tour_code,
    foundCount: landmarks.length,
    totalLandmarks: tourRow.total_landmarks,
    currentSequence: team.current_landmark_sequence,
    totalScore: team.total_score,
    maxScore: Number(totals.max_score) || 0,
    // The live clock itself comes from GET /api/game/clock — this is just for copy that quotes
    // the limit (e.g. the Instructions page's "you have 3 hours").
    timeLimitMinutes: tourRow.time_limit_minutes,
    landmarks,
    // The current landmark once its puzzle is solved but before the quiz/advance — title and
    // photo only (no points/secondsTaken, those aren't final yet, and it deliberately isn't
    // folded into `landmarks`/foundCount above, which still means "fully completed").
    currentRevealed: revealed && { sequenceOrder: revealed.sequence_order, title: revealed.title, imagePath: revealed.image_path },
  });
});

// GET /api/game/current — the only landmark data ever sent: whichever one the team is on now.
// isCaptain rides along on every poll (not just /api/game/session) so a captain-handoff by a
// teammate is picked up by this device's own next poll — see PlayPage.jsx's captain-sync effect.
app.get('/api/game/current', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  const landmark = await getCurrentLandmark(team);

  if (!landmark) {
    return res.json({ tourComplete: true, totalScore: team.total_score, isCaptain: player.is_captain });
  }

  const events = await eventsFor(team.id, landmark.id);
  const hintsRevealed = events.filter((e) => e.event_type === 'clue_hint_used').map((e) => e.payload.hintText);
  const clueRevealed = events.find((e) => e.event_type === 'clue_reveal_used');
  const puzzleSolvedEvent = events.find((e) => e.event_type === 'puzzle_solved'); // "solved" = attempted (right or wrong), single-shot
  const quizAnswered = events.filter((e) => e.event_type === 'quiz_answered');
  const quizCompletedEvent = events.find((e) => e.event_type === 'quiz_completed');

  const { rows: hintRows } = await db.query(
    'SELECT hint_order, hint_text FROM clue_hints WHERE clue_id = $1 ORDER BY hint_order',
    [landmark.clue_id]
  );

  let quizQuestions = [];
  if (puzzleSolvedEvent) {
    // Only the landmark's active quiz_format is served — other types (e.g. a kept-as-backup
    // multiple_choice set while five_right is what's actually played) stay in the DB, unused.
    const { rows } = await db.query(
      'SELECT id, sequence_order, type, question_text, answer_payload, explanation, points FROM quiz_questions WHERE landmark_id = $1 AND type = $2 ORDER BY sequence_order',
      [landmark.id, landmark.quiz_format]
    );
    quizQuestions = rows.map((q) => {
      const answered = quizAnswered.find((e) => Number(e.payload.questionId) === Number(q.id));
      if (q.type === 'five_right') {
        return {
          id: q.id,
          type: q.type,
          questionText: q.question_text,
          title: q.answer_payload.title || null,
          instructions: q.answer_payload.instructions || null,
          // `correct` per tile only revealed once this question has been answered — never in advance.
          // Display order is shuffled (seeded by team+question, so it's stable across polls/devices
          // for this team's playthrough) rather than the authored CSV order.
          tiles: seededShuffle(q.answer_payload.tiles, `${team.id}:${q.id}`).map((t) => ({
            id: t.id,
            name: t.name,
            imagePath: t.imagePath,
            correct: answered ? t.correct : null,
          })),
          answered: Boolean(answered),
          pickedTileIds: answered ? answered.payload.picked : null,
          score: answered ? answered.payload.score : null,
          explanation: answered ? q.explanation : null,
        };
      }
      if (q.type === 'anagram') {
        return {
          id: q.id,
          type: q.type,
          questionText: q.question_text,
          title: q.answer_payload.title || null,
          rowCounts: q.answer_payload.rowCounts,
          // Starting scrambled order before answering; once answered, the board freezes to show
          // what was actually submitted instead (the live in-progress order is client-only state).
          tiles: answered ? null : q.answer_payload.scrambled.split(''),
          submittedTiles: answered ? answered.payload.submitted.split('') : null,
          answered: Boolean(answered),
          wasCorrect: answered ? answered.payload.correct : null,
          // Only revealed once this question has been answered — never in advance.
          correctAnswer: answered ? q.answer_payload.solution : null,
          explanation: answered ? q.explanation : null,
        };
      }
      return {
        id: q.id,
        type: q.type,
        questionText: q.question_text,
        options: q.answer_payload.options || null,
        answered: Boolean(answered),
        wasCorrect: answered ? answered.payload.correct : null,
        // Only revealed once this specific question has been answered — never in advance.
        correctAnswer: answered ? q.answer_payload.correct : null,
        explanation: answered ? q.explanation : null,
      };
    });
  }

  const quizCompleted = quizQuestions.length > 0 && quizQuestions.every((q) => q.answered);
  const landmarkComplete = Boolean(quizCompletedEvent);

  // Dev-only: the real answers, for local testing convenience. Until 2026-10-18 this went to every
  // player, production included — now only when EXPOSE_DEV_ANSWERS allows it (see its definition).
  let _dev;
  if (EXPOSE_DEV_ANSWERS) {
    const { rows: allQuizForDev } = await db.query(
      'SELECT id, question_text, type, answer_payload FROM quiz_questions WHERE landmark_id = $1 ORDER BY sequence_order',
      [landmark.id]
    );
    _dev = {
      puzzleAnswer: readableAnswer(landmark.puzzle_type, landmark.puzzle_answer),
      quizAnswers: allQuizForDev.map((q) => ({
        question: q.question_text,
        answer: readableAnswer(q.type, q.answer_payload),
      })),
    };
  }

  res.json({
    _dev,
    sequenceOrder: landmark.sequence_order,
    title: puzzleSolvedEvent ? landmark.title : null, // withheld until attempted — never reveal the name in advance
    totalScore: team.total_score,
    isCaptain: player.is_captain,
    clue: {
      type: landmark.clue_type,
      text: landmark.clue_text,
      hintsRevealed,
      hintsRemaining: hintRows.length - hintsRevealed.length,
      revealed: Boolean(clueRevealed),
      reveal: clueRevealed
        ? { title: landmark.title, address: landmark.address, latitude: landmark.latitude, longitude: landmark.longitude }
        : null,
    },
    puzzle: {
      questionText: landmark.puzzle_question,
      solved: Boolean(puzzleSolvedEvent), // "attempted" — true whether the one submitted answer was right or wrong
      correct: puzzleSolvedEvent ? puzzleSolvedEvent.payload?.correct : null,
      submittedAnswer: puzzleSolvedEvent ? puzzleSolvedEvent.payload?.answer : null,
      pointsEarned: puzzleSolvedEvent ? puzzleSolvedEvent.points_delta : null,
      hintsUsed: hintsRevealed.length,
      revealUsed: Boolean(clueRevealed),
      // Only revealed once the puzzle has been attempted — never in advance, same pattern as quiz.
      correctAnswer: puzzleSolvedEvent ? readableAnswer(landmark.puzzle_type, landmark.puzzle_answer) : null,
      explanation: puzzleSolvedEvent ? landmark.puzzle_explanation : null,
    },
    quiz: {
      unlocked: Boolean(puzzleSolvedEvent),
      questions: quizQuestions,
      completed: quizCompleted,
      correctCount: quizCompleted ? quizQuestions.filter((q) => q.wasCorrect).length : null,
      pointsEarned: quizCompletedEvent ? quizCompletedEvent.points_delta : null,
    },
    landmarkComplete,
  });
});

// GET /api/game/certificate — the summary behind the confetti popup and the certificate page.
// A team gets a certificate either way the tour can end: by completing every landmark, or by
// running out of time (timeUp — landmarksCompleted then shows how far they got, e.g. 12/14).
// Deliberately built on resolveSession alone, with no game-code expiry check anywhere in this
// route (unlike /api/register) — a finished team must still be able to reach their certificate
// long after the 30-day code expires. Also doubles as the resume-check StartPage's ResumeRedirect
// uses to decide between /certificate, /instructions and /home — hence instructionsComplete
// riding along on the not-finished early return too.
app.get('/api/game/certificate', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;

  const tourComplete = !(await getCurrentLandmark(team));
  const { game, clock, completedCount, playableCount, lastCompletedAt } = await gameClockFor(team);
  if (!tourComplete && !clock.timeUp) {
    return res.json({ tourComplete: false, timeUp: false, instructionsComplete: player.instructions_complete, coachComplete: player.coach_complete });
  }

  const { rows: [row] } = await db.query(
    `SELECT t.name AS tour_name FROM game_codes gc JOIN tours t ON t.id = gc.tour_id WHERE gc.id = $1`,
    [game.game_code_id]
  );
  // When the tour ended: the final landmark's completion, or the moment the clock ran out (its
  // start + every stop's length + the limit — fixed, since a stopped clock can't run out).
  const finishedAt = tourComplete
    ? new Date(lastCompletedAt || Date.now())
    : new Date(new Date(game.clock_started_at).getTime() + (game.paused_seconds + clock.limitSeconds) * 1000);

  res.json({
    tourComplete,
    timeUp: !tourComplete,
    playerName: player.name,
    teamName: team.name,
    tourName: row.tour_name,
    totalScore: team.total_score,
    elapsedSeconds: clock.elapsedSeconds,
    landmarksCompleted: completedCount,
    totalLandmarks: playableCount,
    completedAt: finishedAt.toISOString(),
  });
});

// POST /api/game/instructions-complete — called once, when this player taps "let's start the
// tour" at the end of the paginated onboarding flow. Per-player (not per-team), matching how each
// team member goes through their own copy of the app: a player who quits partway through
// onboarding and reopens the app should land back at the start of instructions, while a
// player who finished should skip straight to /home.
app.post('/api/game/instructions-complete', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actInstructionsComplete(session));
});

// POST /api/game/coach-complete — called once, when this player reaches the end of the guided
// navigation "coach" walkthrough. Per-player, same reasoning as instructions-complete above: a
// player who quits partway through gets shown the whole thing again on their next session,
// while one who finished it doesn't see it auto-launch again. When the captain is the one
// finishing, this is also what starts the team's tour clock (see maybeStartClock).
app.post('/api/game/coach-complete', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actCoachComplete(session, {}, new Date()));
});

// GET /api/game/clock — polled every few seconds by every in-game device (GameClockProvider in
// client/src/gameClock.jsx) for the countdown, stop/restart state, warnings and time's up. Also
// runs maybeStartClock as a self-heal, so a clock whose start condition became true some other
// way (e.g. the dev tools) still starts without waiting for another trigger.
app.get('/api/game/clock', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  await maybeStartClock(session.team);
  res.json(await clockPayload(session.player, session.team));
});

// POST /api/game/clock/stop — captain-only, at most MAX_CLOCK_STOPS times per game (e.g. for
// lunch). Freezes the whole team's app until the captain restarts it. See actClockStop.
app.post('/api/game/clock/stop', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actClockStop(session, {}, new Date()));
});

// POST /api/game/clock/restart — captain-only. Folds the stop's length into paused_seconds, so
// the time used carries on exactly where it left off. See actClockRestart.
app.post('/api/game/clock/restart', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actClockRestart(session, {}, new Date()));
});

// POST /api/game/certificate/send — emails a rasterized PNG of the certificate (built client-side
// from the certificate card's DOM, see CertificatePage.jsx) as an attachment. Any player may send
// (not captain-gated) — this doesn't mutate game state, it's just a personal keepsake.
app.post('/api/game/certificate/send', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actCertificateSend(session, req.body));
});

// POST /api/game/problem-report — emails the app's own inbox with the player's description plus
// team/progress context. Any player may send. See actProblemReport.
app.post('/api/game/problem-report', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actProblemReport(session, req.body));
});

// The direct (online, one-at-a-time) versions of the captain's game actions. Current clients send
// these through POST /api/game/sync instead; these stay for any older client still cached on a
// phone, and share the exact same act* logic (judged at the moment the request arrives).
app.post('/api/game/clue/hint', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actHint(session, req.body, new Date()));
});

app.post('/api/game/clue/reveal', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actReveal(session, req.body, new Date()));
});

app.post('/api/game/puzzle/answer', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actPuzzle(session, req.body, new Date()));
});

app.post('/api/game/quiz/answer', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actQuiz(session, req.body, new Date()));
});

app.post('/api/game/advance', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actAdvance(session, req.body, new Date()));
});

// GET /api/game/landmark/:sequenceOrder — the post-solve detail page (image, facts, external
// link). Only ever returns content for a landmark this team has actually completed — a 403 for
// anything else, same "never reveal in advance" rule as the rest of the game.
app.get('/api/game/landmark/:sequenceOrder', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;
  const sequenceOrder = Number(req.params.sequenceOrder);

  const { rows: [landmark] } = await db.query(
    `SELECT l.*,
            -- DESC (not ASC like /api/game/home) — sort_order 1 is a hero crop suited to this
            -- page's wide banner, falling back to the sort_order 0 tile photo if no hero exists.
            (SELECT image_path FROM landmark_images WHERE landmark_id = l.id ORDER BY sort_order DESC LIMIT 1) AS image_path
     FROM landmarks l
     JOIN tours t ON t.id = l.tour_id
     JOIN game_codes gc ON gc.tour_id = t.id
     JOIN games g ON g.game_code_id = gc.id
     WHERE g.id = $1 AND l.sequence_order = $2`,
    [team.game_id, sequenceOrder]
  );
  if (!landmark) return res.status(404).json({ error: 'No such landmark.' });

  // Same "solved" condition /api/game/home uses — covers the start/informational landmark too,
  // which has no explicit landmark_completed event since there's no gameplay to complete. The
  // one exception: the *current* landmark becomes viewable as soon as its puzzle is solved (the
  // "See landmark" button on the solve-result popup) — the title itself is already revealed at
  // that point, so there's nothing left to leak by also showing its detail page.
  if (sequenceOrder >= team.current_landmark_sequence) {
    const { rows: solvedNow } = await db.query(
      `SELECT 1 FROM progress_events WHERE team_id = $1 AND landmark_id = $2 AND event_type = 'puzzle_solved' LIMIT 1`,
      [team.id, landmark.id]
    );
    const isCurrentAndSolved = sequenceOrder === team.current_landmark_sequence && solvedNow.length > 0;
    if (!isCurrentAndSolved) {
      return res.status(403).json({ error: 'This landmark has not been completed yet.' });
    }
  }

  let audioBonusEarned = false;
  if (landmark.audio_path) {
    const { rows: bonusRows } = await db.query(
      'SELECT 1 FROM narration_listens WHERE team_id = $1 AND landmark_id = $2',
      [team.id, landmark.id]
    );
    audioBonusEarned = bonusRows.length > 0;
  }

  res.json({
    sequenceOrder: landmark.sequence_order,
    isCurrent: sequenceOrder === team.current_landmark_sequence,
    title: landmark.title,
    address: landmark.address,
    imagePath: landmark.image_path,
    aboutLandmarkLabel: landmark.about_landmark_label,
    aboutLandmarkText: landmark.about_landmark_text,
    aboutSubjectLabel: landmark.about_subject_label,
    aboutSubjectText: landmark.about_subject_text,
    interestingFact: landmark.interesting_fact,
    externalLink: landmark.external_link,
    audioPath: landmark.audio_path,
    audioBonusEarned,
  });
});

// GET /api/game/map — solved landmarks + curated sites for the Map view. Same "never reveal the
// current/future landmark" rule as /api/game/home: only landmarks strictly before the team's
// current sequence are included.
app.get('/api/game/map', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const { rows: [tourRow] } = await db.query(
    `SELECT t.id FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );

  const { rows: solvedLandmarks } = await db.query(
    `SELECT l.sequence_order, l.title, l.latitude, l.longitude,
            (SELECT image_path FROM landmark_images WHERE landmark_id = l.id ORDER BY sort_order LIMIT 1) AS image_path
     FROM landmarks l
     WHERE l.tour_id = $1 AND l.sequence_order < $2
     ORDER BY l.sequence_order`,
    [tourRow.id, team.current_landmark_sequence]
  );

  // Map pins only need enough to place and label the pin — full content loads on the site's own
  // detail page (GET /api/game/site/:id), same split as landmarks (map pin vs landmark detail).
  const { rows: sites } = await db.query(
    `SELECT id, title, type, latitude, longitude, image_path
     FROM sites WHERE tour_id = $1 ORDER BY id`,
    [tourRow.id]
  );

  const revealed = await currentRevealedLandmark(team, tourRow.id);

  res.json({
    solvedLandmarks: solvedLandmarks.map((l) => ({
      sequenceOrder: l.sequence_order,
      title: l.title,
      latitude: Number(l.latitude),
      longitude: Number(l.longitude),
      imagePath: l.image_path,
    })),
    // The current landmark once its puzzle is solved but before the quiz/advance — a real pin at
    // its real (already-visited) location, deliberately separate from solvedLandmarks so it
    // doesn't extend the walking-path polyline or get treated as a completed stop.
    currentRevealed: revealed && {
      sequenceOrder: revealed.sequence_order,
      title: revealed.title,
      latitude: Number(revealed.latitude),
      longitude: Number(revealed.longitude),
      imagePath: revealed.image_path,
    },
    sites: sites.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      imagePath: s.image_path,
    })),
  });
});

// GET /api/game/site/:id — a curated site's full detail content. Sites aren't part of the game
// loop (no clue/puzzle/quiz, no sequence), so unlike landmarks there's no completion gating —
// scoped to the team's own tour only so a site from a different tour can't be requested by id.
app.get('/api/game/site/:id', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const { rows: [tourRow] } = await db.query(
    `SELECT t.id FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );

  const { rows: [site] } = await db.query(
    `SELECT * FROM sites WHERE id = $1 AND tour_id = $2`,
    [req.params.id, tourRow.id]
  );
  if (!site) return res.status(404).json({ error: 'No such site.' });

  let audioBonusEarned = false;
  if (site.audio_path) {
    const { rows: bonusRows } = await db.query(
      'SELECT 1 FROM narration_listens WHERE team_id = $1 AND site_id = $2',
      [team.id, site.id]
    );
    audioBonusEarned = bonusRows.length > 0;
  }

  res.json({
    title: site.title,
    address: site.address,
    type: site.type,
    imagePath: site.image_path,
    aboutSiteLabel: site.about_site_label,
    aboutSiteText: site.about_site_text,
    aboutSubjectLabel: site.about_subject_label,
    aboutSubjectText: site.about_subject_text,
    interestingFact: site.interesting_fact,
    externalLink: site.external_link,
    audioPath: site.audio_path,
    audioBonusEarned,
  });
});

// Narration "fully listened" bonus — any team member (not just the captain) can trigger this, so
// deliberately not gated by requireCaptain the way the scoring/progress routes above are. Exactly
// one of landmarkSequenceOrder/siteId must be given. The "was this genuinely listened to end to
// end, not skipped" judgment is made client-side (see NarrationPlayer.jsx's coverage tracking) —
// this endpoint's job is just idempotent award-once-per-team enforcement, via narration_listens'
// own partial unique indexes (ON CONFLICT DO NOTHING below), which also makes it race-safe if two
// teammates finish listening at nearly the same moment.
app.post('/api/game/narration/complete', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  sendResult(res, await actNarration(session, req.body, new Date()));
});

// Polled (every few seconds, see NarrationPlayer.jsx) by every team member's device so a bonus
// point earned on one phone — and who earned it — shows up as a toast + ping on everyone else's,
// the same lightweight interval-poll approach PlayPage already uses for syncing the captain's
// gated actions to teammates (see that file's own comment on why: no sockets, fine at this scale).
app.get('/api/game/narration/latest', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const { rows: [latest] } = await db.query(
    `SELECT nl.id, p.name AS player_name
     FROM narration_listens nl
     JOIN players p ON p.id = nl.player_id
     WHERE nl.team_id = $1
     ORDER BY nl.id DESC
     LIMIT 1`,
    [team.id]
  );

  res.json({
    id: latest ? latest.id : null,
    playerName: latest ? latest.player_name : null,
    totalScore: team.total_score,
  });
});

// GET /api/game/route — real walking-route polylines connecting solved landmarks, one leg per
// consecutive pair, via Google's Routes API. Extends to the current landmark too once its puzzle
// is solved (same reveal gate as currentRevealedLandmark) — the player has already physically
// walked that leg to find it, so showing it isn't leaking anything ahead; only a genuinely
// unsolved/unrevealed landmark's route stays hidden. Cached forever per process, keyed by the
// team's exact (sequence, revealed) state rather than just a point count — two different states
// can otherwise produce the same waypoint count with different actual coordinates (e.g. "2 fully
// solved" vs "1 solved + 1 just-revealed"), which would silently serve the wrong cached route.
const routeCache = new Map();

app.get('/api/game/route', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const { rows: [tourRow] } = await db.query(
    `SELECT t.id FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );

  const { rows: solvedLandmarks } = await db.query(
    `SELECT latitude, longitude FROM landmarks
     WHERE tour_id = $1 AND sequence_order < $2
     ORDER BY sequence_order`,
    [tourRow.id, team.current_landmark_sequence]
  );

  const revealed = await currentRevealedLandmark(team, tourRow.id);
  const routePoints = revealed ? [...solvedLandmarks, revealed] : solvedLandmarks;

  if (routePoints.length < 2) return res.json({ legs: [] });

  const cacheKey = `${tourRow.id}:${team.current_landmark_sequence}:${revealed ? 'revealed' : 'solved'}`;
  if (routeCache.has(cacheKey)) return res.json({ legs: routeCache.get(cacheKey) });

  const waypoints = routePoints.map((l) => ({
    location: { latLng: { latitude: Number(l.latitude), longitude: Number(l.longitude) } },
  }));

  try {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'routes.legs.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: waypoints[0],
        destination: waypoints[waypoints.length - 1],
        intermediates: waypoints.slice(1, -1),
        travelMode: 'WALK',
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));

    const legs = (body.routes?.[0]?.legs || []).map((leg) => leg.polyline.encodedPolyline);
    routeCache.set(cacheKey, legs);
    res.json({ legs });
  } catch (err) {
    console.error('Routes API error:', err);
    res.status(502).json({ error: 'Could not compute walking route.' });
  }
});

// POST /api/dev/login — dev-tools-only auto-login, used to skip the registration form entirely
// when the client is running in dev mode (see client/src/devMode.js). Activates/joins the seeded
// DEV-LOCAL game code exactly like /api/register would, rather than fabricating a session
// client-side, so the resulting session is a real, server-issued row like any other. Idempotent —
// safe to call on every dev-mode app load. Always normalizes the captain's name/team name back to
// "Calvin" / "The Eggheads" per the fixed dev identity, in case the row predates that convention.
app.post('/api/dev/login', async (req, res) => {
  const DEV_CODE = 'DEV-LOCAL';
  const { rows: [gameCode] } = await db.query('SELECT * FROM game_codes WHERE code = $1', [DEV_CODE]);
  if (!gameCode) return res.status(500).json({ error: `Dev game code "${DEV_CODE}" is not seeded in this database.` });

  let game;
  if (gameCode.status === 'unused') {
    const { rows: [newGame] } = await db.query(
      `INSERT INTO games (game_code_id, time_limit_minutes)
       VALUES ($1, (SELECT time_limit_minutes FROM tours WHERE id = $2)) RETURNING *`,
      [gameCode.id, gameCode.tour_id]
    );
    await db.query(`UPDATE game_codes SET status = 'activated' WHERE id = $1`, [gameCode.id]);
    game = newGame;
  } else {
    ({ rows: [game] } = await db.query('SELECT * FROM games WHERE game_code_id = $1', [gameCode.id]));
  }

  let { rows: [team] } = await db.query('SELECT * FROM teams WHERE game_id = $1', [game.id]);
  if (!team) {
    const minSequence = await firstPlayableSequence(gameCode.tour_id);
    ({ rows: [team] } = await db.query(
      `INSERT INTO teams (game_id, current_landmark_sequence) VALUES ($1, $2) RETURNING *`,
      [game.id, minSequence]
    ));
  }
  if (team.name !== 'The Eggheads') {
    await db.query(`UPDATE teams SET name = 'The Eggheads' WHERE id = $1`, [team.id]);
  }

  let { rows: [player] } = await db.query('SELECT * FROM players WHERE team_id = $1 AND is_captain = true', [team.id]);
  if (!player) {
    const sessionToken = crypto.randomBytes(24).toString('hex');
    ({ rows: [player] } = await db.query(
      `INSERT INTO players (team_id, name, avatar, is_captain, session_token) VALUES ($1, 'Calvin', '🦁', true, $2) RETURNING *`,
      [team.id, sessionToken]
    ));
  } else {
    const avatar = player.avatar || '🦁';
    if (player.name !== 'Calvin' || player.avatar !== avatar) {
      await db.query(`UPDATE players SET name = 'Calvin', avatar = $2 WHERE id = $1`, [player.id, avatar]);
    }
  }

  const { rows: [freshTeam] } = await db.query('SELECT * FROM teams WHERE id = $1', [team.id]);
  const { rows: [freshPlayer] } = await db.query('SELECT * FROM players WHERE id = $1', [player.id]);
  res.json(await registrationStatus(freshPlayer, freshTeam));
});

// Resolves the calling session's tour id — every dev/reset-style endpoint needs it, and it's
// otherwise buried three joins deep from a team row.
async function tourIdForTeam(team) {
  const { rows: [tourRow] } = await db.query(
    `SELECT t.id FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );
  return tourRow.id;
}

// Dev-only convenience: wipe the calling session's own team progress and start their tour over.
// Scoped to just this team (not a global TRUNCATE like before) — with real registration now live,
// wiping every team's data on one player's "Reset" tap would break everyone else's game.
app.post('/api/dev/reset', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const minSequence = await firstPlayableSequence(await tourIdForTeam(team));
  await db.query('DELETE FROM progress_events WHERE team_id = $1', [team.id]);
  await db.query('UPDATE teams SET total_score = 0, current_landmark_sequence = $2 WHERE id = $1', [team.id, minSequence]);
  await resetGameClock(team);
  res.json({ reset: true });
});

// Back to a never-started clock with both stops unused, on the tour's current time limit. The
// clock then starts again by the normal rule — straight away if the captain has already finished
// the walkthrough (the usual dev case), via the next GET /api/game/clock's maybeStartClock.
async function resetGameClock(team) {
  await db.query(
    `UPDATE games g SET clock_started_at = NULL, clock_paused_at = NULL, paused_seconds = 0, pauses_used = 0,
       time_limit_minutes = t.time_limit_minutes
     FROM game_codes gc JOIN tours t ON t.id = gc.tour_id
     WHERE g.id = $1 AND gc.id = g.game_code_id`,
    [team.game_id]
  );
}

// Dev-only clock shortcuts (Dev Tools menu) — for testing the stop/restart flow, the last-30-
// minute warnings and time's up without waiting hours:
//   start        — start the clock now if it hasn't started
//   minutes-left — set the clock running with exactly `minutes` left (clears any stop in progress)
//   reset-stops  — give the captain both stops back
//   not-started  — back to a never-started clock AND mark the calling player's walkthrough
//                  unfinished, so the "captain finishes the walkthrough -> clock starts" path
//                  (and members' "waiting for your captain" banner) can be replayed end to end
app.post('/api/dev/clock', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  const { action, minutes } = req.body || {};

  if (action === 'start') {
    await db.query('UPDATE games SET clock_started_at = now() WHERE id = $1 AND clock_started_at IS NULL', [team.game_id]);
  } else if (action === 'minutes-left') {
    await db.query(
      `UPDATE games SET clock_paused_at = NULL, paused_seconds = 0,
         clock_started_at = now() - make_interval(secs => GREATEST(0, time_limit_minutes * 60 - $2::int * 60))
       WHERE id = $1`,
      [team.game_id, Number(minutes) || 0]
    );
  } else if (action === 'reset-stops') {
    await db.query('UPDATE games SET pauses_used = 0 WHERE id = $1', [team.game_id]);
  } else if (action === 'not-started') {
    await resetGameClock(team);
    await db.query('UPDATE players SET coach_complete = false WHERE id = $1', [player.id]);
  } else {
    return res.status(400).json({ error: `Unknown dev clock action "${action}".` });
  }

  const { rows: [freshPlayer] } = await db.query('SELECT * FROM players WHERE id = $1', [player.id]);
  res.json(await clockPayload(freshPlayer, team));
});

// Dev-only: reset, then fast-forward the calling session's own team through the first `count`
// landmarks as if they'd solved everything correctly with no hints — for jumping straight to a
// particular Home-screen state (N landmarks found) without manually replaying the whole game.
app.post('/api/dev/complete/:count', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  let team = session.team;
  const count = Number(req.params.count);

  const minSequence = await firstPlayableSequence(await tourIdForTeam(team));
  await db.query('DELETE FROM progress_events WHERE team_id = $1', [team.id]);
  await db.query('UPDATE teams SET total_score = 0, current_landmark_sequence = $2 WHERE id = $1', [team.id, minSequence]);
  const { rows: [refreshedTeam] } = await db.query('SELECT * FROM teams WHERE id = $1', [team.id]);
  team = refreshedTeam;

  // JOIN puzzles — "Landmark N complete" means N *playable* landmarks, skipping any
  // start/informational landmark that has no gameplay to fast-forward through.
  const { rows: landmarks } = await db.query(
    `SELECT l.* FROM landmarks l
     JOIN puzzles p ON p.landmark_id = l.id
     JOIN tours t ON t.id = l.tour_id
     JOIN game_codes gc ON gc.tour_id = t.id
     JOIN games g ON g.game_code_id = gc.id
     WHERE g.id = $1
     ORDER BY l.sequence_order
     LIMIT $2`,
    [team.game_id, count]
  );

  // The tour's actual final playable landmark (not just the last one `count` happened to reach) —
  // known independently of the LIMIT above so "All landmarks complete" can stop one step short of
  // a fully-finished tour: puzzle solved, quiz left undone, so dev testing can walk through the
  // real final quiz and the tour-complete flow (confetti popup, certificate) by hand instead of
  // jumping straight past it.
  const { rows: [{ max_sequence: lastPlayableSequence }] } = await db.query(
    `SELECT MAX(l.sequence_order) AS max_sequence
     FROM landmarks l JOIN puzzles p ON p.landmark_id = l.id
     WHERE l.tour_id = $1`,
    [await tourIdForTeam(team)]
  );

  for (const landmark of landmarks) {
    const { rows: [puzzle] } = await db.query('SELECT * FROM puzzles WHERE landmark_id = $1', [landmark.id]);
    const answer = readableAnswer(puzzle.type, puzzle.answer_payload);
    const puzzlePointsEarned = puzzlePoints(0, false, true);
    await db.query(
      `INSERT INTO progress_events (team_id, landmark_id, event_type, points_delta, payload) VALUES ($1, $2, 'puzzle_solved', $3, $4)`,
      [team.id, landmark.id, puzzlePointsEarned, JSON.stringify({ correct: true, answer })]
    );
    await db.query('UPDATE teams SET total_score = total_score + $1 WHERE id = $2', [puzzlePointsEarned, team.id]);

    if (landmark.sequence_order === lastPlayableSequence) continue;

    const { rows: questions } = await db.query(
      'SELECT id FROM quiz_questions WHERE landmark_id = $1 ORDER BY sequence_order',
      [landmark.id]
    );
    for (const q of questions) {
      await db.query(
        `INSERT INTO progress_events (team_id, landmark_id, event_type, payload) VALUES ($1, $2, 'quiz_answered', $3)`,
        [team.id, landmark.id, JSON.stringify({ questionId: q.id, correct: true })]
      );
    }
    const quizPointsEarned = quizPoints(questions.length);
    await db.query(
      `INSERT INTO progress_events (team_id, landmark_id, event_type, points_delta) VALUES ($1, $2, 'quiz_completed', $3)`,
      [team.id, landmark.id, quizPointsEarned]
    );
    await db.query(
      `INSERT INTO progress_events (team_id, landmark_id, event_type) VALUES ($1, $2, 'landmark_completed')`,
      [team.id, landmark.id]
    );
    await db.query('UPDATE teams SET total_score = total_score + $1 WHERE id = $2', [quizPointsEarned, team.id]);
    await db.query('UPDATE teams SET current_landmark_sequence = current_landmark_sequence + 1 WHERE id = $1', [team.id]);
  }

  res.json({ completedCount: landmarks.length });
});

// ============================================================================================
// Game actions — the one implementation of everything a player can DO. Shared by the direct
// routes above (judged at the moment the request arrives) and POST /api/game/sync (judged at the
// moment the player tapped, for actions queued on a phone while it was out of signal). Each
// returns { status, body } instead of writing the response, so sync can collect a batch of them.
// The phone runs a mirror of these rules (client/src/offline/engine.js) to show results
// instantly with no signal — any rule change here must be made there too.
// ============================================================================================

const okResult = (body) => ({ status: 200, body });
const failResult = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

function sendResult(res, result) {
  res.status(result.status).json(result.body);
}

async function addProgressEvent(team, landmark, player, eventType, pointsDelta, payload, at) {
  await db.query(
    `INSERT INTO progress_events (team_id, landmark_id, player_id, event_type, points_delta, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [team.id, landmark.id, player.id, eventType, pointsDelta || 0, payload ? JSON.stringify(payload) : null, at]
  );
}

function puzzleIsCorrect(type, payload, answer) {
  if (type === 'exact_numeric') return String(answer).trim() === String(payload.answer).trim();
  if (type === 'fuzzy_text') return payload.accepted.some((a) => normalize(a) === normalize(answer));
  return false;
}

// Shared gate for the captain's scoring/progress actions (hint, reveal, puzzle/quiz answer,
// advance): captain only, the clock running at `at`, and a current landmark to act on.
async function captainGameGate(session, at) {
  if (!session.player.is_captain) return { fail: failResult(403, 'Only your team captain can do this.') };
  const clockError = await clockBlockError(session.team, at);
  if (clockError) return { fail: failResult(423, clockError, { clockBlocked: true }) };
  const landmark = await getCurrentLandmark(session.team);
  if (!landmark) return { fail: failResult(400, 'Your tour is already complete.') };
  return { landmark };
}

// Hints are asked for by number (hintNumber 1, 2, ...), so a repeated request — a double tap, or a
// phone re-sending after the first reply was lost in a dead spot — gets back the hint it already
// used instead of spending the next one (a real bug before 2026-10-18). No hintNumber = "the next
// one", for older clients.
async function actHint(session, body, at) {
  const { player, team } = session;
  const gate = await captainGameGate(session, at);
  if (gate.fail) return gate.fail;
  const { landmark } = gate;
  const used = (await eventsFor(team.id, landmark.id)).filter((e) => e.event_type === 'clue_hint_used');
  const wanted = Number(body?.hintNumber) || used.length + 1;
  if (wanted <= used.length) return okResult({ hintText: used[wanted - 1].payload.hintText, duplicate: true });
  if (wanted > used.length + 1) return failResult(400, 'Hints must be used in order.');

  const { rows: [hint] } = await db.query(
    'SELECT hint_text FROM clue_hints WHERE clue_id = $1 AND hint_order = $2',
    [landmark.clue_id, wanted]
  );
  if (!hint) return failResult(400, 'No more hints available.');
  await addProgressEvent(team, landmark, player, 'clue_hint_used', 0, { hintText: hint.hint_text }, at);
  return okResult({ hintText: hint.hint_text });
}

async function actReveal(session, body, at) {
  const { player, team } = session;
  const gate = await captainGameGate(session, at);
  if (gate.fail) return gate.fail;
  const { landmark } = gate;
  const events = await eventsFor(team.id, landmark.id);
  if (!events.some((e) => e.event_type === 'clue_reveal_used')) {
    await addProgressEvent(team, landmark, player, 'clue_reveal_used', 0, null, at);
  }
  return okResult({ title: landmark.title, address: landmark.address, latitude: landmark.latitude, longitude: landmark.longitude });
}

// Single-shot: one submission ends this stage regardless of whether it's right or wrong —
// there is no retry. The client should never show this form again once puzzle.solved is true.
async function actPuzzle(session, body, at) {
  const { player, team } = session;
  const gate = await captainGameGate(session, at);
  if (gate.fail) return gate.fail;
  const { landmark } = gate;
  const answer = body?.answer ?? '';

  const events = await eventsFor(team.id, landmark.id);
  if (events.some((e) => e.event_type === 'puzzle_solved')) {
    return failResult(400, 'This puzzle has already been answered.');
  }

  const payload = landmark.puzzle_answer;
  const correct = puzzleIsCorrect(landmark.puzzle_type, payload, answer);
  const hintsUsed = events.filter((e) => e.event_type === 'clue_hint_used').length;
  const revealUsed = events.some((e) => e.event_type === 'clue_reveal_used');
  const pointsEarned = puzzlePoints(hintsUsed, revealUsed, correct);

  await addProgressEvent(team, landmark, player, 'puzzle_solved', pointsEarned, { correct, answer }, at);
  await db.query('UPDATE teams SET total_score = total_score + $1 WHERE id = $2', [pointsEarned, team.id]);

  return okResult({
    correct,
    correctAnswer: readableAnswer(landmark.puzzle_type, payload),
    explanation: landmark.puzzle_explanation,
    pointsEarned,
    hintsUsed,
    revealUsed,
  });
}

// Single-shot per question too. Points are NOT awarded per question — each answer is recorded
// with points_delta 0, and once all of them are in, a lump sum is awarded in one 'quiz_completed'
// event. Advancing to the next landmark is a separate step (actAdvance) — deliberately not done
// here, otherwise the completion screen would never get a chance to render.
async function actQuiz(session, body, at) {
  const { player, team } = session;
  const gate = await captainGameGate(session, at);
  if (gate.fail) return gate.fail;
  const { landmark } = gate;
  const questionId = Number(body?.questionId);
  const answer = body?.answer;

  const events = await eventsFor(team.id, landmark.id);
  if (!events.some((e) => e.event_type === 'puzzle_solved')) {
    return failResult(400, 'Answer the Prove it question first.');
  }
  if (events.some((e) => e.event_type === 'quiz_answered' && Number(e.payload.questionId) === questionId)) {
    return failResult(400, 'This question has already been answered.');
  }

  const { rows: [question] } = await db.query('SELECT * FROM quiz_questions WHERE id = $1', [questionId]);
  // Must belong to the landmark the team is actually on — never trusted to the client (an old
  // queued answer for a previous landmark, or a hand-crafted request, would otherwise score).
  if (!question || String(question.landmark_id) !== String(landmark.id)) {
    return failResult(400, "That question isn't part of your current landmark.");
  }

  // five_right: `answer` is an array of tile ids the captain tapped, any number of them — +1 per
  // correct tile picked, -1 per wrong one, so this single question's own score (-4..+5) already IS
  // the lump-sum points, unlike multiple_choice where points come once every question is answered.
  const isFiveRight = question.type === 'five_right';
  const isAnagram = question.type === 'anagram';
  let correct = null;
  let fiveRightScore = null;
  if (isFiveRight) {
    const picked = Array.isArray(answer) ? answer.map(Number) : [];
    fiveRightScore = question.answer_payload.tiles.reduce(
      (score, tile) => (picked.includes(tile.id) ? score + (tile.correct ? 1 : -1) : score),
      0
    );
    await addProgressEvent(team, landmark, player, 'quiz_answered', 0, { questionId, picked, score: fiveRightScore }, at);
  } else if (isAnagram) {
    correct = normalize(question.answer_payload.solution) === normalize(answer);
    await addProgressEvent(team, landmark, player, 'quiz_answered', 0, { questionId, correct, submitted: answer }, at);
  } else {
    correct = normalize(question.answer_payload.correct) === normalize(answer);
    await addProgressEvent(team, landmark, player, 'quiz_answered', 0, { questionId, correct }, at);
  }

  // Only this landmark's active quiz_format is ever "the quiz" for completion purposes — a kept
  // backup set of a different type (see landmarks.quiz_format) must never block completion.
  const { rows: allQuestions } = await db.query(
    'SELECT id FROM quiz_questions WHERE landmark_id = $1 AND type = $2',
    [landmark.id, question.type]
  );
  const freshEvents = await eventsFor(team.id, landmark.id);
  const answered = freshEvents.filter((e) => e.event_type === 'quiz_answered');
  // Number(...) both sides: pg returns bigint id columns as strings, but payload.questionId
  // came from a JSON request body as a number — without normalizing, this comparison is always false.
  const quizComplete = allQuestions.every((q) => answered.some((e) => Number(e.payload.questionId) === Number(q.id)));

  let quizPointsEarned = null;
  let correctCount = null;
  if (quizComplete) {
    quizPointsEarned = isFiveRight
      ? fiveRightScore
      : isAnagram
        ? (correct ? ANAGRAM_POINTS : 0)
        : quizPoints((correctCount = answered.filter((e) => e.payload.correct).length));

    await addProgressEvent(team, landmark, player, 'quiz_completed', quizPointsEarned, null, at);
    await db.query('UPDATE teams SET total_score = total_score + $1 WHERE id = $2', [quizPointsEarned, team.id]);
    await addProgressEvent(team, landmark, player, 'landmark_completed', 0, null, at);
  }

  return okResult({
    type: question.type,
    correct,
    correctAnswer: isFiveRight ? null : isAnagram ? question.answer_payload.solution : question.answer_payload.correct,
    // Reveals every tile's correct/wrong flag at once — the whole point of the format is seeing
    // all 9 answers together after submitting, not one at a time.
    tiles: isFiveRight ? question.answer_payload.tiles.map((t) => ({ id: t.id, correct: t.correct })) : null,
    score: fiveRightScore,
    explanation: question.explanation,
    quizComplete,
    correctCount,
    quizPointsEarned,
  });
}

// The "Head to next landmark" tap. Only actually moves the team on once the current landmark
// really has a landmark_completed event — guards against a client calling this out of turn.
async function actAdvance(session, body, at) {
  const { team } = session;
  const gate = await captainGameGate(session, at);
  if (gate.fail) return gate.fail;
  const { landmark } = gate;
  const events = await eventsFor(team.id, landmark.id);
  if (!events.some((e) => e.event_type === 'landmark_completed')) {
    return failResult(400, 'This landmark is not complete yet.');
  }
  await db.query('UPDATE teams SET current_landmark_sequence = current_landmark_sequence + 1 WHERE id = $1', [team.id]);
  return okResult({ advanced: true });
}

// At most MAX_CLOCK_STOPS per game. The conditional UPDATE is the real guard (atomic against a
// double tap); the checks before it are just for clear errors. `at` becomes the stop's start, so a
// stop tapped in a dead spot pauses the clock from that moment, not from when it reached us.
async function actClockStop(session, body, at) {
  const { player, team } = session;
  if (!player.is_captain) return failResult(403, 'Only your team captain can do this.');
  const { clock, allCompleted, game } = await gameClockFor(team, at);
  if (!clock.started || clock.timeUp || allCompleted) return failResult(400, "The clock isn't running.");
  if (clock.paused) return failResult(400, 'The clock is already stopped.');
  if (game.pauses_used >= MAX_CLOCK_STOPS) return failResult(400, "You've used all your clock stops.");

  const { rowCount } = await db.query(
    `UPDATE games SET clock_paused_at = $3, pauses_used = pauses_used + 1
     WHERE id = $1 AND clock_started_at IS NOT NULL AND clock_started_at <= $3
       AND clock_paused_at IS NULL AND pauses_used < $2`,
    [team.game_id, MAX_CLOCK_STOPS, at]
  );
  if (!rowCount) return failResult(409, 'The clock could not be stopped — try again.');
  return okResult(await clockPayload(player, team));
}

// Folds the stop's length (up to `at`) into paused_seconds, so the time used carries on exactly
// where it left off.
async function actClockRestart(session, body, at) {
  const { player, team } = session;
  if (!player.is_captain) return failResult(403, 'Only your team captain can do this.');
  const { rowCount } = await db.query(
    `UPDATE games
     SET paused_seconds = paused_seconds + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - clock_paused_at))))::int,
         clock_paused_at = NULL
     WHERE id = $1 AND clock_paused_at IS NOT NULL`,
    [team.game_id, at]
  );
  if (!rowCount) return failResult(400, "The clock isn't stopped.");
  return okResult(await clockPayload(player, team));
}

// Narration "fully listened" bonus — any team member (not just the captain) can trigger this. The
// "was this genuinely listened to end to end" judgment is made client-side (see NarrationPlayer.jsx's
// coverage tracking) — this is just idempotent award-once-per-team enforcement, via
// narration_listens' own partial unique indexes (ON CONFLICT DO NOTHING), which also makes it
// race-safe if two teammates finish listening at nearly the same moment.
async function actNarration(session, body, at) {
  const { team, player } = session;
  const { landmarkSequenceOrder, siteId } = body || {};

  // No bonus points while the clock isn't running — otherwise a team could bank listens before
  // the captain starts the clock, or during a stop. Not an error: the listen just doesn't score.
  const { clock: bonusClock } = await gameClockFor(team, at);
  if (!bonusClock.started || bonusClock.paused || bonusClock.timeUp) {
    return okResult({ awarded: false, totalScore: team.total_score });
  }

  let landmarkId = null;
  let siteRowId = null;
  if (landmarkSequenceOrder != null) {
    const { rows: [landmark] } = await db.query(
      'SELECT id, audio_path FROM landmarks WHERE tour_id = $1 AND sequence_order = $2',
      [await tourIdForTeam(team), Number(landmarkSequenceOrder)]
    );
    if (!landmark) return failResult(404, 'No such landmark.');
    if (!landmark.audio_path) return failResult(400, 'This landmark has no narration.');
    landmarkId = landmark.id;
  } else if (siteId != null) {
    const { rows: [site] } = await db.query('SELECT id, audio_path FROM sites WHERE id = $1', [siteId]);
    if (!site) return failResult(404, 'No such site.');
    if (!site.audio_path) return failResult(400, 'This site has no narration.');
    siteRowId = site.id;
  } else {
    return failResult(400, 'landmarkSequenceOrder or siteId required.');
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO narration_listens (team_id, landmark_id, site_id, player_id, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [team.id, landmarkId, siteRowId, player.id, at]
  );

  const awarded = inserted.length > 0;
  let totalScore = team.total_score;
  if (awarded) {
    const { rows: [updated] } = await db.query(
      'UPDATE teams SET total_score = total_score + 1 WHERE id = $1 RETURNING total_score',
      [team.id]
    );
    totalScore = updated.total_score;
  }
  return okResult({ awarded, totalScore });
}

// Per-player flags. Finishing the walkthrough as captain is what starts the clock — from `at`, so
// a walkthrough finished in a dead spot starts the clock when it was really finished.
async function actCoachComplete(session, body, at) {
  await db.query('UPDATE players SET coach_complete = true WHERE id = $1', [session.player.id]);
  await maybeStartClock(session.team, at);
  return okResult({ ok: true });
}

async function actInstructionsComplete(session) {
  await db.query('UPDATE players SET instructions_complete = true WHERE id = $1', [session.player.id]);
  return okResult({ ok: true });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function actCertificateSend(session, body) {
  const { email, imageDataUrl } = body || {};
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return failResult(400, 'Enter a valid email address.');
  }
  const match = typeof imageDataUrl === 'string' && imageDataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return failResult(400, 'Missing certificate image.');

  try {
    await mailTransporter.sendMail({
      from: `TOURZ <${process.env.GMAIL_USER}>`,
      to: email.trim(),
      // Neutral wording — the certificate may be for a team that ran out of time, not just one
      // that completed every landmark.
      subject: 'Your TOURZ certificate',
      text: 'Thanks for walking with TOURZ! Your certificate is attached.',
      attachments: [{ filename: 'tourz-certificate.png', content: Buffer.from(match[1], 'base64') }],
    });
    return okResult({ sent: true });
  } catch (err) {
    console.error('Certificate email error:', err);
    return failResult(502, 'Could not send the email — try again.');
  }
}

async function actProblemReport(session, body) {
  const { player, team } = session;
  const message = String(body?.message || '').trim();
  if (!message) return failResult(400, 'Enter a description of the problem.');

  const { rows: [info] } = await db.query(
    `SELECT t.name AS tour_name, l.title AS current_landmark_title,
            (SELECT COUNT(*) FROM progress_events pe
             WHERE pe.team_id = tm.id AND pe.event_type = 'landmark_completed') AS landmarks_completed
     FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     LEFT JOIN landmarks l ON l.tour_id = t.id AND l.sequence_order = tm.current_landmark_sequence
     WHERE tm.id = $1`,
    [team.id]
  );

  const details = [
    `Team: ${team.name}`,
    `Player: ${player.name} ${player.avatar}${player.is_captain ? ' (captain)' : ''}`,
    `Tour: ${info?.tour_name || 'unknown'}`,
    `Current landmark: ${info?.current_landmark_title || `sequence ${team.current_landmark_sequence}`}`,
    `Landmarks completed: ${info?.landmarks_completed ?? 0}`,
    `Score: ${team.total_score}`,
  ].join('\n');

  try {
    await mailTransporter.sendMail({
      from: `TOURZ <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `TOURZ problem report — ${team.name}`,
      text: `${details}\n\nProblem description:\n${message}`,
    });
    return okResult({ sent: true });
  } catch (err) {
    console.error('Problem report email error:', err);
    return failResult(502, 'Could not send the report — try again.');
  }
}

// ============================================================================================
// Offline play (built 2026-10-18 after a live tour froze in a mobile-signal dead spot).
//   GET  /api/game/state     — everything the phone needs to run the game on its own: team
//                              progress, the clock's raw columns, solved landmarks' details, and
//                              the current + next LOOKAHEAD_LANDMARKS landmarks' full packages
//                              (clue, all hints, puzzle, quiz, answers), sealed (see sealJson).
//   POST /api/game/sync      — replays the actions a phone queued, in order, each judged at its
//                              own tap time (clamped to MAX_BACKDATE_MS), idempotent by action id.
//   GET  /api/game/tour-pack — every site's full detail, downloaded once at the start of the tour.
// ============================================================================================

// How many landmarks past the current one a phone holds, so a team that walks into a dead spot
// can keep solving and advancing through them. User decision 2026-10-18: first 3, then changed the
// same day to the WHOLE tour (Infinity) — every landmark's card, clue, hints, Prove it question
// and quiz go to the phone in the initial load, so no stretch without signal can ever leave a team
// waiting for the next clue. Trade-off accepted: the whole route and its answers are on the phone
// from the start (sealed — obfuscated, not secure). Set a number to go back to a rolling window.
const LOOKAHEAD_LANDMARKS = Infinity;
// Oldest tap time a synced action may claim. User decision 2026-10-18: 20 minutes — enough to
// cover a long dead spot, short enough that a doctored phone clock can't claw back real time.
const MAX_BACKDATE_MS = 20 * 60 * 1000;

// Obfuscation, not security: anything a phone can check and reveal with no signal is, by
// definition, on the phone. This keeps upcoming clues/answers out of plain sight in the network
// tab and storage. XOR with a keystream from the same generator seededShuffle uses, seeded by the
// player's session token + landmark. Mirror: client/src/offline/seal.js — keep them identical.
function sealJson(obj, keyStr) {
  const bytes = Buffer.from(JSON.stringify(obj), 'utf8');
  const rand = seededRandom(keyStr);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= Math.floor(rand() * 256);
  return bytes.toString('base64');
}

const msOrNull = (d) => (d ? new Date(d).getTime() : null);

async function sessionForPlayer(playerId) {
  const { rows: [player] } = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
  const { rows: [team] } = await db.query('SELECT * FROM teams WHERE id = $1', [player.team_id]);
  return { player, team };
}

async function tourForTeam(team) {
  const { rows: [row] } = await db.query(
    `SELECT t.id, t.name, t.tour_code, t.total_landmarks, g.activated_at
     FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );
  return row;
}

// Cheap fingerprint of everything /state depends on — the phone polls with ?v=<last version> and
// gets a tiny { unchanged: true } back unless something actually moved (a 4s full-state poll would
// otherwise cost tens of MB an hour of mobile data).
async function stateVersion(team) {
  const { rows: [row] } = await db.query(
    `SELECT
       (SELECT COALESCE(MAX(id), 0) FROM progress_events WHERE team_id = t.id) AS ev,
       (SELECT COUNT(*) FROM progress_events WHERE team_id = t.id) AS evc,
       (SELECT COALESCE(MAX(id), 0) FROM narration_listens WHERE team_id = t.id) AS nl,
       (SELECT string_agg(id || ':' || is_captain || ':' || coach_complete || ':' || instructions_complete || ':' || name, ',' ORDER BY id)
          FROM players WHERE team_id = t.id) AS pl,
       t.current_landmark_sequence, t.total_score, t.name,
       g.clock_started_at, g.clock_paused_at, g.paused_seconds, g.pauses_used, g.time_limit_minutes
     FROM teams t JOIN games g ON g.id = t.game_id
     WHERE t.id = $1`,
    [team.id]
  );
  return crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16);
}

function landmarkDetailFields(l) {
  return {
    aboutLandmarkLabel: l.about_landmark_label,
    aboutLandmarkText: l.about_landmark_text,
    aboutSubjectLabel: l.about_subject_label,
    aboutSubjectText: l.about_subject_text,
    interestingFact: l.interesting_fact,
    externalLink: l.external_link,
    audioPath: l.audio_path,
  };
}

async function buildStatePayload(session) {
  const { player, team } = session;
  const tour = await tourForTeam(team);
  const { game, playableCount } = await gameClockFor(team);
  const version = await stateVersion(team);
  const { rows: [captain] } = await db.query('SELECT name FROM players WHERE team_id = $1 AND is_captain', [team.id]);

  const { rows: landmarkRows } = await db.query(
    `SELECT l.*, c.id AS clue_id, c.type AS clue_type, c.clue_text,
            p.type AS puzzle_type, p.question_text AS puzzle_question, p.answer_payload AS puzzle_answer,
            p.explanation AS puzzle_explanation,
            (SELECT image_path FROM landmark_images WHERE landmark_id = l.id ORDER BY sort_order LIMIT 1) AS tile_image,
            (SELECT image_path FROM landmark_images WHERE landmark_id = l.id ORDER BY sort_order DESC LIMIT 1) AS hero_image
     FROM landmarks l
     LEFT JOIN clues c ON c.landmark_id = l.id
     LEFT JOIN puzzles p ON p.landmark_id = l.id
     WHERE l.tour_id = $1
     ORDER BY l.sequence_order`,
    [tour.id]
  );

  // Same max-score sum /api/game/home uses.
  const { rows: [totals] } = await db.query(
    `SELECT SUM(30 + COALESCE(q.points_sum, 0)) AS max_score
     FROM landmarks l
     JOIN puzzles p ON p.landmark_id = l.id
     LEFT JOIN (SELECT landmark_id, SUM(points) AS points_sum FROM quiz_questions GROUP BY landmark_id) q ON q.landmark_id = l.id
     WHERE l.tour_id = $1`,
    [tour.id]
  );

  const { rows: eventRows } = await db.query(
    `SELECT pe.id, pe.event_type, pe.points_delta, pe.payload, pe.created_at, l.sequence_order
     FROM progress_events pe JOIN landmarks l ON l.id = pe.landmark_id
     WHERE pe.team_id = $1
     ORDER BY pe.id`,
    [team.id]
  );

  const { rows: listenRows } = await db.query(
    `SELECT nl.id, nl.site_id, l.sequence_order AS landmark_seq, p.name AS player_name
     FROM narration_listens nl
     LEFT JOIN landmarks l ON l.id = nl.landmark_id
     JOIN players p ON p.id = nl.player_id
     WHERE nl.team_id = $1
     ORDER BY nl.id`,
    [team.id]
  );

  const current = team.current_landmark_sequence;
  const playableSeqs = landmarkRows.filter((l) => l.puzzle_type).map((l) => l.sequence_order);

  const landmarks = [];
  for (const l of landmarkRows) {
    const base = { seq: l.sequence_order, playable: Boolean(l.puzzle_type) };
    if (l.sequence_order < current) {
      // Already passed — nothing left to protect, so sent in the clear.
      landmarks.push({
        ...base,
        title: l.title,
        address: l.address,
        latitude: Number(l.latitude),
        longitude: Number(l.longitude),
        tileImage: l.tile_image,
        heroImage: l.hero_image,
        detail: landmarkDetailFields(l),
      });
      continue;
    }
    if (!l.puzzle_type || l.sequence_order > current + LOOKAHEAD_LANDMARKS) continue;

    const { rows: hintRows } = await db.query(
      'SELECT hint_text FROM clue_hints WHERE clue_id = $1 ORDER BY hint_order',
      [l.clue_id]
    );
    // Only the landmark's active quiz_format is played — same rule as /api/game/current.
    const { rows: quizRows } = await db.query(
      `SELECT id, sequence_order, type, question_text, answer_payload, explanation, points
       FROM quiz_questions WHERE landmark_id = $1 AND type = $2 ORDER BY sequence_order`,
      [l.id, l.quiz_format]
    );
    const pkg = {
      title: l.title,
      address: l.address,
      latitude: Number(l.latitude),
      longitude: Number(l.longitude),
      tileImage: l.tile_image,
      heroImage: l.hero_image,
      detail: landmarkDetailFields(l),
      clue: { type: l.clue_type, text: l.clue_text },
      hints: hintRows.map((h) => h.hint_text),
      puzzle: {
        type: l.puzzle_type,
        question: l.puzzle_question,
        answer: l.puzzle_answer,
        readable: readableAnswer(l.puzzle_type, l.puzzle_answer),
        explanation: l.puzzle_explanation,
      },
      quiz: quizRows.map((q) => ({
        id: Number(q.id),
        sequenceOrder: q.sequence_order,
        type: q.type,
        questionText: q.question_text,
        // five_right tiles pre-shuffled exactly as /api/game/current does (seeded team+question).
        payload: q.type === 'five_right'
          ? { ...q.answer_payload, tiles: seededShuffle(q.answer_payload.tiles, `${team.id}:${q.id}`) }
          : q.answer_payload,
        explanation: q.explanation,
        points: q.points,
      })),
    };
    landmarks.push({ ...base, sealed: sealJson(pkg, `${player.session_token}:${l.sequence_order}`) });
  }

  return {
    version,
    serverNow: Date.now(),
    lookahead: Number.isFinite(LOOKAHEAD_LANDMARKS) ? LOOKAHEAD_LANDMARKS : 'all',
    team: { id: Number(team.id), name: team.name, currentSequence: current, totalScore: team.total_score },
    player: {
      id: Number(player.id),
      name: player.name,
      avatar: player.avatar,
      isCaptain: player.is_captain,
      coachComplete: player.coach_complete,
      instructionsComplete: player.instructions_complete,
    },
    tour: {
      id: Number(tour.id),
      name: tour.name,
      tourCode: tour.tour_code,
      totalLandmarks: tour.total_landmarks,
      timeLimitMinutes: game.time_limit_minutes,
      maxScore: Number(totals.max_score) || 0,
      playableCount,
      firstPlayableSequence: playableSeqs.length ? Math.min(...playableSeqs) : null,
      lastPlayableSequence: playableSeqs.length ? Math.max(...playableSeqs) : null,
      activatedAt: msOrNull(game.activated_at),
    },
    clock: {
      gameId: Number(game.id),
      startedAt: msOrNull(game.clock_started_at),
      pausedAt: msOrNull(game.clock_paused_at),
      pausedSeconds: game.paused_seconds,
      pausesUsed: game.pauses_used,
      maxStops: MAX_CLOCK_STOPS,
      limitSeconds: game.time_limit_minutes * 60,
      captainName: captain ? captain.name : null,
    },
    events: eventRows.map((e) => ({
      id: Number(e.id),
      seq: e.sequence_order,
      type: e.event_type,
      pointsDelta: e.points_delta,
      payload: e.payload,
      createdAt: msOrNull(e.created_at),
    })),
    narration: listenRows.map((n) => ({
      id: Number(n.id),
      landmarkSeq: n.landmark_seq,
      siteId: n.site_id != null ? Number(n.site_id) : null,
      playerName: n.player_name,
    })),
    landmarks,
  };
}

app.get('/api/game/state', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  // Same self-heal the clock poll has always done.
  await maybeStartClock(session.team);
  const version = await stateVersion(session.team);
  if (req.query.v && req.query.v === version) {
    return res.json({ unchanged: true, version, serverNow: Date.now() });
  }
  res.json(await buildStatePayload(session));
});

// One sync at a time per team (this is a single Node process) — the lie-fi case is a phone
// re-sending a batch while the first copy is still being processed, and the claim row below
// can't make that safe on its own without serialising.
const teamSyncLocks = new Map();
function withTeamLock(teamId, fn) {
  const key = String(teamId);
  const run = (teamSyncLocks.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  teamSyncLocks.set(key, tail);
  tail.then(() => { if (teamSyncLocks.get(key) === tail) teamSyncLocks.delete(key); });
  return run;
}

const SYNC_ACTIONS = {
  hint: actHint,
  reveal: actReveal,
  puzzle: actPuzzle,
  quiz: actQuiz,
  advance: actAdvance,
  clock_stop: actClockStop,
  clock_restart: actClockRestart,
  narration: actNarration,
  coach_complete: actCoachComplete,
  instructions_complete: actInstructionsComplete,
  problem_report: actProblemReport,
  certificate_send: actCertificateSend,
};

async function applyClientAction(playerId, action) {
  const id = String(action?.id || '').slice(0, 100);
  const fn = SYNC_ACTIONS[action?.type];
  if (!id || !fn) return { id, status: 400, body: { error: 'Unknown action.' } };

  // Fresh team/captain state for every action — the one before may have moved the team on.
  const session = await sessionForPlayer(playerId);
  const now = Date.now();
  const tapped = Date.parse(action.clientTime);
  const at = new Date(Number.isFinite(tapped) ? Math.min(now, Math.max(now - MAX_BACKDATE_MS, tapped)) : now);

  // Claim the id first. Already there = a re-send: answer from the stored result instead of
  // applying it again.
  const { rows: claimed } = await db.query(
    `INSERT INTO client_actions (id, team_id, player_id, action_type, client_time, applied_time)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, session.team.id, session.player.id, action.type, Number.isFinite(tapped) ? new Date(tapped) : null, at]
  );
  if (!claimed.length) {
    const { rows: [prev] } = await db.query('SELECT * FROM client_actions WHERE id = $1', [id]);
    if (String(prev.team_id) !== String(session.team.id)) return { id, status: 400, body: { error: 'Unknown action.' } };
    if (prev.status == null) {
      // Claimed but never finished — only possible if the server died mid-action. Don't guess
      // whether it half-applied; tell the phone to drop it (the next state refresh shows the truth).
      return { id, status: 410, body: { error: 'This action was interrupted on the server.' } };
    }
    return { id, status: prev.status, body: prev.result, duplicate: true };
  }

  let result;
  try {
    result = await fn(session, action.payload || {}, at);
  } catch (err) {
    console.error(`Sync action ${action.type} failed:`, err);
    result = { status: 500, body: { error: 'Server error.' } };
  }
  if (result.status >= 500) {
    // Transient (e.g. the mail server) — release the claim so the phone's retry runs it for real.
    await db.query('DELETE FROM client_actions WHERE id = $1', [id]);
  } else {
    await db.query('UPDATE client_actions SET status = $2, result = $3 WHERE id = $1', [id, result.status, JSON.stringify(result.body)]);
  }
  return { id, ...result };
}

app.post('/api/game/sync', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const actions = Array.isArray(req.body?.actions) ? req.body.actions.slice(0, 200) : [];
  const results = await withTeamLock(session.team.id, async () => {
    const out = [];
    for (const action of actions) out.push(await applyClientAction(session.player.id, action));
    return out;
  });
  res.json({ results, state: await buildStatePayload(await sessionForPlayer(session.player.id)) });
});

app.get('/api/game/tour-pack', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const tour = await tourForTeam(session.team);
  const { rows } = await db.query('SELECT * FROM sites WHERE tour_id = $1 ORDER BY id', [tour.id]);
  const sites = rows.map((s) => ({
    id: Number(s.id),
    title: s.title,
    type: s.type,
    address: s.address,
    latitude: Number(s.latitude),
    longitude: Number(s.longitude),
    imagePath: s.image_path,
    aboutSiteLabel: s.about_site_label,
    aboutSiteText: s.about_site_text,
    aboutSubjectLabel: s.about_subject_label,
    aboutSubjectText: s.about_subject_text,
    interestingFact: s.interesting_fact,
    externalLink: s.external_link,
    audioPath: s.audio_path,
  }));
  const version = crypto.createHash('sha1').update(JSON.stringify(sites)).digest('hex').slice(0, 16);
  res.json({ tourId: Number(tour.id), version, sites });
});

const PORT = process.env.PORT || 3001;
db.connect()
  .then(() => {
    app.listen(PORT, () => console.log(`TOURZ API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
