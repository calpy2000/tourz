// Pushes one tour's CONTENT tables (landmarks, landmark_images, clues, clue_hints, puzzles,
// quiz_questions, sites) from its local db/content/<tour-folder>/*.csv files to a target
// database - WITHOUT touching that tour's row, its game_codes, or any instance data (games,
// teams, players, progress_events, messages, location_pings). This is the missing piece
// referenced in diff-content.js's comment, and exists specifically because db/seed.js's
// wipeTour() deletes ALL of that instance data as part of reseeding a tour - fine for local
// dev, unsafe for prod once a tour has live game codes with real players registered under them
// (confirmed 2026-09-23: prod Edinburgh had 10 active codes + 1 registered team/player).
//
// Requires the target tour to already exist (looked up by tour_code from tour.json) - this
// only ever updates an existing tour's content, it never creates a tour. Use db/seed.js for
// that (new tour / local dev full reseed).
//
// Usage:
//   node scripts/db-sync/sync-content.js <tour-folder> --dry-run   (read-only, reports counts)
//   node scripts/db-sync/sync-content.js <tour-folder>             (writes, local DB by default)
//   DATABASE_URL=1 node scripts/db-sync/sync-content.js <tour-folder>   (writes to prod - any
//     non-empty DATABASE_URL value works as the flag; the real credential is read from
//     scripts/game-codes/.env via connections.js, never from this env var's value)

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');
const { prodDatabaseUrl } = require('./connections');

const tourFolder = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!tourFolder) {
  console.error('Usage: node scripts/db-sync/sync-content.js <tour-folder> [--dry-run]');
  process.exit(1);
}

const contentDir = path.join(__dirname, '..', '..', 'db', 'content', tourFolder);

function readManifest() {
  const filePath = path.join(contentDir, 'tour.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath} - every tour folder needs a tour.json manifest.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCsv(filename) {
  const filePath = path.join(contentDir, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

// Same convention as db/seed.js - kept in sync by hand, see that file's own comment. A
// fuzzy_text answer may list several accepted variants separated by "|" (e.g. "clock|a clock") -
// each is trimmed into its own accepted entry; a plain single-value answer (no "|") still
// produces the same one-element array as before.
function puzzleAnswerPayload(type, answer) {
  if (type === 'exact_numeric') return { answer };
  if (type === 'fuzzy_text') return { accepted: String(answer).split('|').map((s) => s.trim()) };
  if (type === 'multiple_choice') return { correct: answer };
  throw new Error(`Unknown puzzle type: ${type}`);
}

function quizAnswerPayload(row) {
  if (row.type === 'multiple_choice') {
    const options = [row.option_a, row.option_b, row.option_c, row.option_d].filter(Boolean);
    return { options, correct: row.correct_answer };
  }
  if (row.type === 'fuzzy_text') {
    return { accepted: [row.correct_answer] };
  }
  throw new Error(`Unknown quiz question type: ${row.type}`);
}

// Deletes everything downstream of landmarks (images/clues/hints/puzzles/quiz) plus sites, for
// this tour - none of these are referenced by any instance table, so delete+reinsert is safe.
// Deliberately does NOT touch landmarks itself (see upsertLandmarks) or any instance data
// (tours, game_codes, games, teams, players, progress_events, messages, location_pings).
async function deleteDownstreamContentForTour(client, tourId) {
  await client.query(`
    DELETE FROM quiz_questions WHERE landmark_id IN (SELECT id FROM landmarks WHERE tour_id = $1)`, [tourId]);
  await client.query(`
    DELETE FROM puzzles WHERE landmark_id IN (SELECT id FROM landmarks WHERE tour_id = $1)`, [tourId]);
  await client.query(`
    DELETE FROM clue_hints WHERE clue_id IN (
      SELECT c.id FROM clues c JOIN landmarks l ON c.landmark_id = l.id WHERE l.tour_id = $1
    )`, [tourId]);
  await client.query(`
    DELETE FROM clues WHERE landmark_id IN (SELECT id FROM landmarks WHERE tour_id = $1)`, [tourId]);
  await client.query(`
    DELETE FROM landmark_images WHERE landmark_id IN (SELECT id FROM landmarks WHERE tour_id = $1)`, [tourId]);
  await client.query(`DELETE FROM sites WHERE tour_id = $1`, [tourId]);
}

// landmarks.id is referenced by progress_events (real player progress), so unlike everything
// else in the content tree it can never be blindly deleted+reinserted - that would break FK
// integrity (or, on prod, destroy a live team's in-progress game). Instead: update existing rows
// in place by natural key (tour_id, sequence_order), preserving their id; insert genuinely new
// sequence_orders; and for a sequence_order that's disappeared from the CSV, only delete it if
// nothing still references it (via a savepoint, so one un-removable landmark doesn't abort the
// whole sync) - otherwise leave it in place and surface a warning.
async function upsertLandmarks(client, tourId, landmarks) {
  const { rows: existing } = await client.query(
    'SELECT id, sequence_order FROM landmarks WHERE tour_id = $1', [tourId]);
  const existingBySequence = new Map(existing.map((r) => [String(r.sequence_order), r.id]));
  const csvSequences = new Set(landmarks.map((r) => String(r.sequence_order)));

  const landmarkIdBySequence = {};
  const warnings = [];

  for (const row of landmarks) {
    const existingId = existingBySequence.get(String(row.sequence_order));
    const values = [
      row.title, row.address, row.latitude || null, row.longitude || null,
      row.about_landmark_label || null, row.about_landmark_text || null,
      row.about_subject_label || null, row.about_subject_text || null,
      row.interesting_fact || null, row.external_link || null, row.quiz_format || 'multiple_choice',
    ];

    if (existingId) {
      await client.query(
        `UPDATE landmarks SET title=$1, address=$2, latitude=$3, longitude=$4,
           about_landmark_label=$5, about_landmark_text=$6, about_subject_label=$7,
           about_subject_text=$8, interesting_fact=$9, external_link=$10, quiz_format=$11
         WHERE id = $12`,
        [...values, existingId]
      );
      landmarkIdBySequence[row.sequence_order] = existingId;
    } else {
      const { rows: [landmark] } = await client.query(
        `INSERT INTO landmarks
           (tour_id, sequence_order, title, address, latitude, longitude,
            about_landmark_label, about_landmark_text, about_subject_label, about_subject_text,
            interesting_fact, external_link, quiz_format)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [tourId, row.sequence_order, ...values]
      );
      landmarkIdBySequence[row.sequence_order] = landmark.id;
    }
  }

  for (const row of existing) {
    if (csvSequences.has(String(row.sequence_order))) continue;
    await client.query('SAVEPOINT remove_landmark');
    try {
      await client.query('DELETE FROM landmarks WHERE id = $1', [row.id]);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT remove_landmark');
      warnings.push(`landmark id ${row.id} (sequence_order ${row.sequence_order}) is no longer in the CSV but still has references (e.g. player progress) - left in place, not deleted.`);
    }
  }

  return { landmarkIdBySequence, warnings };
}

async function main() {
  const { tourCode, cityName, tourName } = readManifest();
  if (!tourCode) throw new Error(`${tourFolder}/tour.json must have tourCode.`);

  const landmarks = readCsv('landmarks.csv');
  const clueHints = readCsv('clue_hints.csv');
  const quizQuestions = readCsv('quiz_questions.csv');
  const quizFiveRight = readCsv('quiz_five_right.csv');
  const quizAnagram = readCsv('quiz_anagram.csv');
  const sites = readCsv('sites.csv');

  // DATABASE_URL is used only as an on/off flag here - the real connection string is read from
  // scripts/game-codes/.env (gitignored) via connections.js, so a prod push never needs the
  // actual credential pasted into a command line. Set DATABASE_URL to any non-empty value to
  // target prod, e.g. `DATABASE_URL=1 node scripts/db-sync/sync-content.js <tour>`.
  const client = process.env.DATABASE_URL
    ? new Client({ connectionString: prodDatabaseUrl(), ssl: { rejectUnauthorized: false } })
    : new Client({ host: 'localhost', port: 5432, user: 'postgres', database: 'tourz' });
  await client.connect();

  try {
    const { rows: [tour] } = await client.query('SELECT id, name FROM tours WHERE tour_code = $1', [tourCode]);
    if (!tour) {
      throw new Error(`No existing tour with tour_code '${tourCode}' on this DB - sync-content.js only updates an existing tour, it never creates one. Use db/seed.js for a brand-new tour.`);
    }

    if (dryRun) {
      const { rows: [{ count: gcCount }] } = await client.query(
        'SELECT count(*) FROM game_codes WHERE tour_id = $1', [tour.id]);
      const { rows: [{ count: landmarkCount }] } = await client.query(
        'SELECT count(*) FROM landmarks WHERE tour_id = $1', [tour.id]);
      const { rows: [{ count: siteCount }] } = await client.query(
        'SELECT count(*) FROM sites WHERE tour_id = $1', [tour.id]);
      console.log(`[dry-run] Target: '${tourCode}' (${tour.name}), tour id ${tour.id}`);
      console.log(`[dry-run] Untouched (instance data): ${gcCount} game_code(s) and everything under them.`);
      console.log(`[dry-run] Would delete+reinsert content: ${landmarkCount} -> ${landmarks.length} landmark(s), ${siteCount} -> ${sites.length} site(s).`);
      console.log(`[dry-run] No writes performed.`);
      return;
    }

    await client.query('BEGIN');

    await deleteDownstreamContentForTour(client, tour.id);
    const { landmarkIdBySequence, warnings } = await upsertLandmarks(client, tour.id, landmarks);
    const clueIdBySequence = {};

    for (const row of landmarks) {
      const landmark = { id: landmarkIdBySequence[row.sequence_order] };

      if (row.image_path) {
        await client.query(
          `INSERT INTO landmark_images (landmark_id, image_path, sort_order) VALUES ($1, $2, 0)`,
          [landmark.id, row.image_path]
        );
      }
      if (row.hero_image_path) {
        await client.query(
          `INSERT INTO landmark_images (landmark_id, image_path, sort_order) VALUES ($1, $2, 1)`,
          [landmark.id, row.hero_image_path]
        );
      }

      if (row.clue_type) {
        const { rows: [clue] } = await client.query(
          `INSERT INTO clues (landmark_id, type, clue_text) VALUES ($1, $2, $3) RETURNING id`,
          [landmark.id, row.clue_type, row.clue_text]
        );
        clueIdBySequence[row.sequence_order] = clue.id;

        await client.query(
          `INSERT INTO puzzles (landmark_id, type, question_text, answer_payload, explanation)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            landmark.id,
            row.puzzle_type,
            row.puzzle_question,
            puzzleAnswerPayload(row.puzzle_type, row.puzzle_answer),
            row.puzzle_explanation || null,
          ]
        );
      }
    }

    for (const row of clueHints) {
      const clueId = clueIdBySequence[row.landmark_sequence_order];
      await client.query(
        `INSERT INTO clue_hints (clue_id, hint_order, hint_text) VALUES ($1, $2, $3)`,
        [clueId, row.hint_order, row.hint_text]
      );
    }

    for (const row of quizQuestions) {
      const landmarkId = landmarkIdBySequence[row.landmark_sequence_order];
      await client.query(
        `INSERT INTO quiz_questions (landmark_id, sequence_order, type, question_text, answer_payload, explanation)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [landmarkId, row.question_order, row.type, row.question_text, quizAnswerPayload(row), row.explanation || null]
      );
    }

    const fiveRightGroups = new Map();
    for (const row of quizFiveRight) {
      const key = `${row.landmark_sequence_order}:${row.question_order}`;
      if (!fiveRightGroups.has(key)) {
        fiveRightGroups.set(key, {
          landmarkSequence: row.landmark_sequence_order,
          questionOrder: row.question_order,
          title: row.title,
          instructions: row.instructions,
          tiles: [],
        });
      }
      fiveRightGroups.get(key).tiles.push({
        id: Number(row.tile_order),
        name: row.name,
        imagePath: row.image_path,
        correct: row.correct === 'true',
      });
    }
    for (const group of fiveRightGroups.values()) {
      const landmarkId = landmarkIdBySequence[group.landmarkSequence];
      await client.query(
        `INSERT INTO quiz_questions (landmark_id, sequence_order, type, question_text, answer_payload, explanation)
         VALUES ($1, $2, 'five_right', $3, $4, $5)`,
        [
          landmarkId,
          group.questionOrder,
          group.title,
          JSON.stringify({ title: group.title, instructions: group.instructions, tiles: group.tiles }),
          null,
        ]
      );
    }

    for (const row of quizAnagram) {
      const landmarkId = landmarkIdBySequence[row.landmark_sequence_order];
      await client.query(
        `INSERT INTO quiz_questions (landmark_id, sequence_order, type, question_text, answer_payload, explanation)
         VALUES ($1, $2, 'anagram', $3, $4, $5)`,
        [
          landmarkId,
          row.question_order,
          row.question_text,
          JSON.stringify({
            title: row.title,
            solution: row.solution,
            scrambled: row.scrambled,
            rowCounts: row.row_counts.split(',').map(Number),
          }),
          row.explanation || null,
        ]
      );
    }

    for (const row of sites) {
      await client.query(
        `INSERT INTO sites
           (tour_id, title, address, type, latitude, longitude,
            about_site_label, about_site_text, about_subject_label, about_subject_text,
            interesting_fact, image_path, external_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          tour.id,
          row.title,
          row.address,
          row.type,
          row.latitude,
          row.longitude,
          row.about_site_label || null,
          row.about_site_text || null,
          row.about_subject_label || null,
          row.about_subject_text || null,
          row.interesting_fact || null,
          row.image_path || null,
          row.external_link || null,
        ]
      );
    }

    await client.query('UPDATE tours SET total_landmarks = $1 WHERE id = $2', [landmarks.length, tour.id]);

    await client.query('COMMIT');
    console.log(`Synced '${tourCode}' (${tour.name}): ${landmarks.length} landmarks, ${clueHints.length} hints, ${quizQuestions.length + fiveRightGroups.size + quizAnagram.length} quiz questions, ${sites.length} sites. Instance data (game_codes/games/teams/players) untouched.`);
    if (warnings.length) {
      console.log(`\nWarnings:`);
      warnings.forEach((w) => console.log(`  - ${w}`));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
