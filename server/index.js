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
const fs = require('fs');
const crypto = require('crypto');
const { parse: parseCsv } = require('csv-parse/sync');
const { Client } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
// 10mb (not the default 100kb) — the certificate-email route posts a rasterized PNG as a base64
// data URL, which runs several hundred KB even for a small card.
app.use(express.json({ limit: '10mb' }));
app.use('/content-photos', express.static(path.join(__dirname, 'content-photos')));

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

function readableAnswer(type, payload) {
  if (type === 'exact_numeric') return payload.answer;
  if (type === 'fuzzy_text') return payload.accepted[0];
  if (type === 'multiple_choice') return payload.correct;
  return JSON.stringify(payload);
}

function formatMessage(row) {
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    createdAt: row.created_at,
    playerId: row.player_id,
    playerName: row.player_name,
    playerAvatar: row.player_avatar,
  };
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
    `SELECT gc.max_players FROM game_codes gc JOIN games g ON g.game_code_id = gc.id WHERE g.id = $1`,
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
    const { rows: [game] } = await db.query(
      `INSERT INTO games (game_code_id, expires_at) VALUES ($1, now() + interval '6 hours') RETURNING *`,
      [gameCode.id]
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
    if (new Date(game.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This game has expired — its 6-hour window is over.' });
    }
    const { rows: [existingTeam] } = await db.query('SELECT * FROM teams WHERE game_id = $1', [game.id]);
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
  await db.query(
    `INSERT INTO messages (team_id, type, text) VALUES ($1, 'player_joined', $2)`,
    [team.id, `🎉 ${player.name} has joined the team`]
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

// GET /api/game/messages?after=<id> — polled from the client (see ChatPanel.jsx), same simple
// interval-poll pattern already used for gameplay sync rather than sockets. `after` omitted (or
// 0) returns the most recent page for the initial load; `after` set returns only newer rows,
// using `messages.id` as the replay cursor per the schema's append-only design.
app.get('/api/game/messages', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const after = Number(req.query.after) || 0;

  const { rows } = after > 0
    ? await db.query(
        `SELECT m.id, m.type, m.text, m.created_at, m.player_id, p.name AS player_name, p.avatar AS player_avatar
         FROM messages m LEFT JOIN players p ON p.id = m.player_id
         WHERE m.team_id = $1 AND m.id > $2 ORDER BY m.id`,
        [session.team.id, after]
      )
    : await db.query(
        `SELECT m.id, m.type, m.text, m.created_at, m.player_id, p.name AS player_name, p.avatar AS player_avatar
         FROM messages m LEFT JOIN players p ON p.id = m.player_id
         WHERE m.team_id = $1 ORDER BY m.id DESC LIMIT 30`,
        [session.team.id]
      );

  if (after === 0) rows.reverse();
  res.json({ messages: rows.map(formatMessage) });
});

// POST /api/game/messages — any player may send (not captain-gated, unlike scoring actions —
// chat has no real-world value to protect). 500-char cap is a sanity limit, not a design decision.
app.post('/api/game/messages', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is required.' });
  if (text.length > 500) return res.status(400).json({ error: 'Message is too long.' });

  const { rows: [row] } = await db.query(
    `INSERT INTO messages (team_id, player_id, type, text) VALUES ($1, $2, 'chat', $3) RETURNING *`,
    [session.team.id, session.player.id, text]
  );
  res.json(formatMessage({ ...row, player_name: session.player.name, player_avatar: session.player.avatar }));
});

// GET /api/game/home — header stats + the tile/list view's solved-landmark data.
// Never includes anything about the current or future landmarks beyond "you have one in progress".
app.get('/api/game/home', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;

  const { rows: [tourRow] } = await db.query(
    `SELECT t.id, t.name, t.total_landmarks, g.activated_at
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
    `SELECT l.id, l.sequence_order, l.title,
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

  let previousTime = new Date(tourRow.activated_at);
  const landmarks = solved.map((l) => {
    const completedEvent = completedEvents.find((e) => e.landmark_id === l.id);
    const completedAt = completedEvent ? new Date(completedEvent.created_at) : null;
    const secondsTaken = completedAt ? Math.round((completedAt - previousTime) / 1000) : null;
    if (completedAt) previousTime = completedAt;
    return {
      sequenceOrder: l.sequence_order,
      title: l.title,
      imagePath: l.image_path,
      points: pointsByLandmark[l.id] || 0,
      secondsTaken,
    };
  });

  res.json({
    teamName: team.name,
    tourName: tourRow.name,
    foundCount: landmarks.length,
    totalLandmarks: tourRow.total_landmarks,
    currentSequence: team.current_landmark_sequence,
    totalScore: team.total_score,
    maxScore: Number(totals.max_score) || 0,
    elapsedSeconds: Math.round((Date.now() - new Date(tourRow.activated_at)) / 1000),
    landmarks,
    // The current landmark once its puzzle is solved but before the quiz/advance — title and
    // photo only (no points/secondsTaken, those aren't final yet, and it deliberately isn't
    // folded into `landmarks`/foundCount above, which still means "fully completed").
    currentRevealed: revealed && { sequenceOrder: revealed.sequence_order, title: revealed.title, imagePath: revealed.image_path },
  });
});

// GET /api/game/current — the only landmark data ever sent: whichever one the team is on now.
app.get('/api/game/current', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { team } = session;
  const landmark = await getCurrentLandmark(team);

  if (!landmark) {
    return res.json({ tourComplete: true, totalScore: team.total_score });
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
    const { rows } = await db.query(
      'SELECT id, sequence_order, type, question_text, answer_payload, explanation, points FROM quiz_questions WHERE landmark_id = $1 ORDER BY sequence_order',
      [landmark.id]
    );
    quizQuestions = rows.map((q) => {
      const answered = quizAnswered.find((e) => Number(e.payload.questionId) === Number(q.id));
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

  // Dev-only: the real answers, never sent to a real player — for local testing convenience.
  const { rows: allQuizForDev } = await db.query(
    'SELECT id, question_text, type, answer_payload FROM quiz_questions WHERE landmark_id = $1 ORDER BY sequence_order',
    [landmark.id]
  );

  res.json({
    _dev: {
      puzzleAnswer: readableAnswer(landmark.puzzle_type, landmark.puzzle_answer),
      quizAnswers: allQuizForDev.map((q) => ({
        question: q.question_text,
        answer: readableAnswer(q.type, q.answer_payload),
      })),
    },
    sequenceOrder: landmark.sequence_order,
    title: puzzleSolvedEvent ? landmark.title : null, // withheld until attempted — never reveal the name in advance
    totalScore: team.total_score,
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

// GET /api/game/certificate — completion summary for the confetti popup and the certificate page.
// Deliberately built on resolveSession alone, with no game/game-code expiry check anywhere in this
// route (unlike /api/register) — a completed team must still be able to reach their certificate
// after the 6-hour game window and the 30-day code both expire.
app.get('/api/game/certificate', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;

  const landmark = await getCurrentLandmark(team);
  if (landmark) return res.json({ tourComplete: false });

  const { rows: [row] } = await db.query(
    `SELECT t.name AS tour_name, g.activated_at
     FROM teams tm
     JOIN games g ON g.id = tm.game_id
     JOIN game_codes gc ON gc.id = g.game_code_id
     JOIN tours t ON t.id = gc.tour_id
     WHERE tm.id = $1`,
    [team.id]
  );
  const { rows: [completedEvent] } = await db.query(
    `SELECT created_at FROM progress_events
     WHERE team_id = $1 AND event_type = 'landmark_completed'
     ORDER BY created_at DESC LIMIT 1`,
    [team.id]
  );
  const completedAt = completedEvent ? new Date(completedEvent.created_at) : new Date();
  const elapsedSeconds = Math.round((completedAt - new Date(row.activated_at)) / 1000);

  res.json({
    tourComplete: true,
    playerName: player.name,
    teamName: team.name,
    tourName: row.tour_name,
    totalScore: team.total_score,
    elapsedSeconds,
    completedAt: completedAt.toISOString(),
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/game/certificate/send — emails a rasterized PNG of the certificate (built client-side
// from the certificate card's DOM, see CertificatePage.jsx) as an attachment. Any player may send
// (not captain-gated) — this doesn't mutate game state, it's just a personal keepsake.
app.post('/api/game/certificate/send', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { email, imageDataUrl } = req.body;

  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const match = typeof imageDataUrl === 'string' && imageDataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Missing certificate image.' });

  try {
    await mailTransporter.sendMail({
      from: `TOURZ <${process.env.GMAIL_USER}>`,
      to: email.trim(),
      subject: 'Your TOURZ Certificate of Completion',
      text: 'Congratulations on completing your TOURZ walking tour! Your certificate is attached.',
      attachments: [{ filename: 'tourz-certificate.png', content: Buffer.from(match[1], 'base64') }],
    });
    res.json({ sent: true });
  } catch (err) {
    console.error('Certificate email error:', err);
    res.status(502).json({ error: 'Could not send the email — try again.' });
  }
});

app.post('/api/game/clue/hint', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;
  const landmark = await getCurrentLandmark(team);
  const events = await eventsFor(team.id, landmark.id);
  const usedCount = events.filter((e) => e.event_type === 'clue_hint_used').length;

  const { rows: [hint] } = await db.query(
    'SELECT hint_text FROM clue_hints WHERE clue_id = $1 AND hint_order = $2',
    [landmark.clue_id, usedCount + 1]
  );
  if (!hint) return res.status(400).json({ error: 'No more hints available.' });

  await db.query(
    `INSERT INTO progress_events (team_id, landmark_id, event_type, payload) VALUES ($1, $2, 'clue_hint_used', $3)`,
    [team.id, landmark.id, JSON.stringify({ hintText: hint.hint_text })]
  );
  res.json({ hintText: hint.hint_text });
});

app.post('/api/game/clue/reveal', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;
  const landmark = await getCurrentLandmark(team);
  await db.query(
    `INSERT INTO progress_events (team_id, landmark_id, event_type) VALUES ($1, $2, 'clue_reveal_used')`,
    [team.id, landmark.id]
  );
  res.json({ title: landmark.title, address: landmark.address, latitude: landmark.latitude, longitude: landmark.longitude });
});

// Single-shot: one submission ends this stage regardless of whether it's right or wrong —
// there is no retry. The client should never show this form again once puzzle.solved is true.
app.post('/api/game/puzzle/answer', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;
  const landmark = await getCurrentLandmark(team);
  const { answer } = req.body;

  const events = await eventsFor(team.id, landmark.id);
  if (events.some((e) => e.event_type === 'puzzle_solved')) {
    return res.status(400).json({ error: 'This puzzle has already been answered.' });
  }

  const payload = landmark.puzzle_answer;
  let correct = false;
  if (landmark.puzzle_type === 'exact_numeric') correct = String(answer).trim() === String(payload.answer).trim();
  if (landmark.puzzle_type === 'fuzzy_text') correct = payload.accepted.some((a) => normalize(a) === normalize(answer));

  const hintsUsed = events.filter((e) => e.event_type === 'clue_hint_used').length;
  const revealUsed = events.some((e) => e.event_type === 'clue_reveal_used');
  const pointsEarned = puzzlePoints(hintsUsed, revealUsed, correct);

  await db.query(
    `INSERT INTO progress_events (team_id, landmark_id, event_type, points_delta, payload) VALUES ($1, $2, 'puzzle_solved', $3, $4)`,
    [team.id, landmark.id, pointsEarned, JSON.stringify({ correct, answer })]
  );
  await db.query('UPDATE teams SET total_score = total_score + $1 WHERE id = $2', [pointsEarned, team.id]);

  res.json({
    correct,
    correctAnswer: readableAnswer(landmark.puzzle_type, payload),
    explanation: landmark.puzzle_explanation,
    pointsEarned,
    hintsUsed,
    revealUsed,
  });
});

// Single-shot per question too. Points are NOT awarded per question — each answer is recorded
// with points_delta 0, and once all 4 are in, a lump sum (via quizPoints) is awarded in one
// 'quiz_completed' event based on how many were correct. Advancing to the next landmark is a
// separate step (POST /api/game/advance, fired by the "Continue" tap on the complete screen) —
// deliberately NOT done here, otherwise the client's next refresh would already be looking at
// the next landmark and the completion screen would never get a chance to render.
app.post('/api/game/quiz/answer', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;
  const landmark = await getCurrentLandmark(team);
  const { questionId, answer } = req.body;

  const events = await eventsFor(team.id, landmark.id);
  if (events.some((e) => e.event_type === 'quiz_answered' && e.payload.questionId === questionId)) {
    return res.status(400).json({ error: 'This question has already been answered.' });
  }

  const { rows: [question] } = await db.query('SELECT * FROM quiz_questions WHERE id = $1', [questionId]);
  const correct = normalize(question.answer_payload.correct) === normalize(answer);

  await db.query(
    `INSERT INTO progress_events (team_id, landmark_id, event_type, payload) VALUES ($1, $2, 'quiz_answered', $3)`,
    [team.id, landmark.id, JSON.stringify({ questionId, correct })]
  );

  const { rows: allQuestions } = await db.query('SELECT id FROM quiz_questions WHERE landmark_id = $1', [landmark.id]);
  const freshEvents = await eventsFor(team.id, landmark.id);
  const answered = freshEvents.filter((e) => e.event_type === 'quiz_answered');
  // Number(...) both sides: pg returns bigint id columns as strings, but payload.questionId
  // came from a JSON request body as a number — without normalizing, this comparison is always false.
  const quizComplete = allQuestions.every((q) => answered.some((e) => Number(e.payload.questionId) === Number(q.id)));

  let quizPointsEarned = null;
  let correctCount = null;
  if (quizComplete) {
    correctCount = answered.filter((e) => e.payload.correct).length;
    quizPointsEarned = quizPoints(correctCount);

    await db.query(
      `INSERT INTO progress_events (team_id, landmark_id, event_type, points_delta) VALUES ($1, $2, 'quiz_completed', $3)`,
      [team.id, landmark.id, quizPointsEarned]
    );
    await db.query('UPDATE teams SET total_score = total_score + $1 WHERE id = $2', [quizPointsEarned, team.id]);
    await db.query(
      `INSERT INTO progress_events (team_id, landmark_id, event_type) VALUES ($1, $2, 'landmark_completed')`,
      [team.id, landmark.id]
    );
  }

  res.json({
    correct,
    correctAnswer: question.answer_payload.correct,
    explanation: question.explanation,
    quizComplete,
    correctCount,
    quizPointsEarned,
  });
});

// Fired by the "Continue" tap on the landmark-complete screen. Only actually moves the team on
// once the current landmark really has a landmark_completed event — guards against a client
// calling this out of turn (e.g. before the quiz is actually finished).
app.post('/api/game/advance', async (req, res) => {
  const session = await resolveSession(req, res);
  if (!session) return;
  const { player, team } = session;
  if (!requireCaptain(player, res)) return;
  const landmark = await getCurrentLandmark(team);
  const events = await eventsFor(team.id, landmark.id);
  if (!events.some((e) => e.event_type === 'landmark_completed')) {
    return res.status(400).json({ error: 'This landmark is not complete yet.' });
  }

  await db.query('UPDATE teams SET current_landmark_sequence = current_landmark_sequence + 1 WHERE id = $1', [team.id]);
  res.json({ advanced: true });
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

// Live third-party POIs (food/drink, toilets) — proxied through the backend rather than called
// from the client, so the Places API key never reaches the browser and repeated requests for the
// same tour/category can be cached instead of re-billed. Cache is in-memory (fine at this scale,
// resets on server restart) — see [[reference-google-places-icons]]-style reasoning: these
// businesses don't change minute to minute, so a 24h TTL is generous, not stale.
const PLACES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const placesCache = new Map();

// One combined "google" category for the map's Google layer. Deliberately uses broad parent
// types (not an exhaustive list of ~170 Food and Drink subtypes) — Places API tags a place with
// both its specific type (e.g. "sushi_restaurant") and its broader parent ("restaurant"), and
// Nearby Search matches on any overlap, so these few broad types already surface the whole
// category. Also useful since includedTypes is capped at 50 entries per request.
const PLACE_CATEGORY_TYPES = {
  google: ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery', 'food_court', 'public_bathroom', 'pharmacy'],
};

async function fetchNearbyPlaces(tourId, category) {
  const cacheKey = `${tourId}:${category}`;
  const cached = placesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const { rows: landmarks } = await db.query('SELECT latitude, longitude FROM landmarks WHERE tour_id = $1', [tourId]);
  const centerLat = landmarks.reduce((sum, l) => sum + Number(l.latitude), 0) / landmarks.length;
  const centerLng = landmarks.reduce((sum, l) => sum + Number(l.longitude), 0) / landmarks.length;

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
      // Pro-tier fields (primaryType, formattedAddress, businessStatus, googleMapsUri) — still
      // comfortably free at this scale (5,000/month), one tier up from the id/name/location
      // Essentials fields. Deliberately skips "photos" (Enterprise-adjacent extra call/cost for
      // low value here) and rating/price/hours (Enterprise tier, a bigger cost step — see
      // [[project-mapview-implementation]] for that decision).
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.formattedAddress,places.businessStatus,places.googleMapsUri',
    },
    body: JSON.stringify({
      includedTypes: PLACE_CATEGORY_TYPES[category],
      maxResultCount: 20,
      locationRestriction: {
        circle: { center: { latitude: centerLat, longitude: centerLng }, radius: 800 },
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Places API error: ${JSON.stringify(body)}`);

  const places = (body.places || []).map((p) => ({
    id: p.id,
    name: p.displayName?.text || '',
    latitude: p.location.latitude,
    longitude: p.location.longitude,
    primaryType: p.primaryType || null,
    address: p.formattedAddress || null,
    businessStatus: p.businessStatus || null,
    mapsUri: p.googleMapsUri || null,
  }));

  placesCache.set(cacheKey, { data: places, expiresAt: Date.now() + PLACES_CACHE_TTL_MS });
  return places;
}

// GET /api/places/nearby?category=google
app.get('/api/places/nearby', async (req, res) => {
  const { category } = req.query;
  if (!PLACE_CATEGORY_TYPES[category]) {
    return res.status(400).json({ error: `Unknown category "${category}".` });
  }

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

  try {
    const places = await fetchNearbyPlaces(tourRow.id, category);
    res.json({ places });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not fetch nearby places.' });
  }
});

// Dev-only: serves the in-progress POI research CSV (db/content/edinburgh-tour/POI.csv) straight
// off disk so it can be scattered on the Map view for a visual first-pass review, before any of
// it is curated or seeded into the real `sites` table. Not real game content — a content-sourcing
// review tool. Only rows with both latitude/longitude (interpolated or confirmed) can be plotted;
// unpinned rows (e.g. a "recurring feature" with no located example yet) are dropped here.
app.get('/api/dev/poi-drafts', (req, res) => {
  const filePath = path.join(__dirname, '..', 'db', 'content', 'edinburgh-tour', 'POI.csv');
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });

  const pois = rows
    .filter((row) => row.latitude && row.longitude)
    .map((row) => ({
      leg: row.leg,
      name: row.name,
      type: row.type,
      address: row.address,
      onRoute: row.on_route === 'Y',
      distanceFromRouteM: Number(row.distance_from_route_m),
      interestRating: Number(row.interest_rating),
      description: row.description,
      interestingFact: row.interesting_fact,
      externalLink: row.external_link,
      sourceNotes: row.source_notes,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      geocodeConfidence: row.geocode_confidence,
      imagePath: row.image_path || null,
    }));

  res.json({ pois });
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
      `INSERT INTO games (game_code_id, expires_at) VALUES ($1, now() + interval '6 hours') RETURNING *`,
      [gameCode.id]
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
  res.json({ reset: true });
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

const PORT = process.env.PORT || 3001;
db.connect()
  .then(() => {
    app.listen(PORT, () => console.log(`TOURZ API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
