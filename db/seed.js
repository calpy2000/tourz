// Loads db/content/<tour-folder>/*.csv into the tourz database, for ONE tour at a time.
// Usage: node db/seed.js [tour-folder]   (defaults to 'edinburgh-tour', so plain `npm run seed`
// keeps working unchanged for the existing content-authoring workflow)
//
// Each tour folder needs a tour.json manifest ({ tourCode, cityName, tourName }). The tour is
// looked up by tourCode (not by folder name or a numeric id) — if a tour with that code already
// exists, ONLY that tour's own content and instance data (games/teams/players/etc for its own
// game codes) is wiped and rebuilt. Every other tour in the database is left completely untouched
// — this is what lets multiple tours (e.g. Edinburgh and Port Louis) coexist in the same local DB.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');

const TOUR_FOLDER = process.argv[2] || 'edinburgh-tour';
const contentDir = path.join(__dirname, 'content', TOUR_FOLDER);

function readManifest() {
  const filePath = path.join(contentDir, 'tour.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath} — every tour folder needs a tour.json manifest ({ tourCode, cityName, tourName }).`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCsv(filename) {
  const filePath = path.join(contentDir, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

// Converts the flat CSV puzzle/quiz columns into the JSONB answer_payload shape
// the schema expects. Convention: exact_numeric -> {answer}, fuzzy_text -> {accepted:[]},
// multiple_choice -> {options:[], correct}. A fuzzy_text answer may list several accepted
// variants separated by "|" (e.g. "clock|a clock") - each is trimmed into its own accepted
// entry; a plain single-value answer (no "|") still produces the same one-element array as before.
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

// Deletes everything belonging to one tour — its own content AND the instance data (games/
// teams/players/progress/messages/location_pings) hanging off its own game codes — in FK-safe
// order. Every table is scoped by tour id via a subquery/join, so no other tour is touched.
async function wipeTour(client, tourId) {
  await client.query(`
    DELETE FROM location_pings WHERE player_id IN (
      SELECT p.id FROM players p
      JOIN teams t ON p.team_id = t.id
      JOIN games g ON t.game_id = g.id
      JOIN game_codes gc ON g.game_code_id = gc.id
      WHERE gc.tour_id = $1
    )`, [tourId]);
  await client.query(`
    DELETE FROM messages WHERE team_id IN (
      SELECT t.id FROM teams t JOIN games g ON t.game_id = g.id
      JOIN game_codes gc ON g.game_code_id = gc.id WHERE gc.tour_id = $1
    )`, [tourId]);
  await client.query(`
    DELETE FROM progress_events WHERE team_id IN (
      SELECT t.id FROM teams t JOIN games g ON t.game_id = g.id
      JOIN game_codes gc ON g.game_code_id = gc.id WHERE gc.tour_id = $1
    )`, [tourId]);
  await client.query(`
    DELETE FROM players WHERE team_id IN (
      SELECT t.id FROM teams t JOIN games g ON t.game_id = g.id
      JOIN game_codes gc ON g.game_code_id = gc.id WHERE gc.tour_id = $1
    )`, [tourId]);
  await client.query(`
    DELETE FROM teams WHERE game_id IN (
      SELECT g.id FROM games g JOIN game_codes gc ON g.game_code_id = gc.id WHERE gc.tour_id = $1
    )`, [tourId]);
  await client.query(`
    DELETE FROM games WHERE game_code_id IN (SELECT id FROM game_codes WHERE tour_id = $1)`, [tourId]);
  await client.query(`DELETE FROM game_codes WHERE tour_id = $1`, [tourId]);
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
  await client.query(`DELETE FROM landmarks WHERE tour_id = $1`, [tourId]);
  await client.query(`DELETE FROM sites WHERE tour_id = $1`, [tourId]);
  await client.query(`DELETE FROM tours WHERE id = $1`, [tourId]);
}

async function main() {
  const { tourCode, cityName, tourName } = readManifest();
  if (!tourCode || !cityName || !tourName) {
    throw new Error(`${TOUR_FOLDER}/tour.json must have tourCode, cityName and tourName.`);
  }

  const landmarks = readCsv('landmarks.csv');
  const clueHints = readCsv('clue_hints.csv');
  const quizQuestions = readCsv('quiz_questions.csv');
  const quizFiveRight = readCsv('quiz_five_right.csv');
  const quizAnagram = readCsv('quiz_anagram.csv');
  const sites = readCsv('sites.csv');

  const client = process.env.DATABASE_URL
    ? new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : new Client({ host: 'localhost', port: 5432, user: 'postgres', database: 'tourz' });
  await client.connect();

  try {
    await client.query('BEGIN');

    const { rows: [existingTour] } = await client.query('SELECT id FROM tours WHERE tour_code = $1', [tourCode]);

    // If DEV-LOCAL currently points at the tour we're about to rebuild, remember that so we can
    // recreate it pointing at the fresh tour row afterwards. If it points at some OTHER tour,
    // leave it (and that other tour) alone entirely — this is what makes reseeding one tour safe
    // to run while a different tour is the one currently active in dev mode.
    let recreateDevLocal = false;
    if (existingTour) {
      const { rows: [devLocal] } = await client.query(
        `SELECT 1 FROM game_codes WHERE code = 'DEV-LOCAL' AND tour_id = $1`,
        [existingTour.id]
      );
      recreateDevLocal = !!devLocal;
      await wipeTour(client, existingTour.id);
    }

    let { rows: [city] } = await client.query('SELECT id FROM cities WHERE name = $1', [cityName]);
    if (!city) {
      ({ rows: [city] } = await client.query('INSERT INTO cities (name) VALUES ($1) RETURNING id', [cityName]));
    }
    const { rows: [tour] } = await client.query(
      'INSERT INTO tours (city_id, name, tour_code, total_landmarks) VALUES ($1, $2, $3, $4) RETURNING id',
      [city.id, tourName, tourCode, landmarks.length]
    );

    const landmarkIdBySequence = {};
    const clueIdBySequence = {};

    for (const row of landmarks) {
      const { rows: [landmark] } = await client.query(
        `INSERT INTO landmarks
           (tour_id, sequence_order, title, address, latitude, longitude,
            about_landmark_label, about_landmark_text, about_subject_label, about_subject_text,
            interesting_fact, external_link, quiz_format)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          tour.id,
          row.sequence_order,
          row.title,
          row.address,
          row.latitude || null,
          row.longitude || null,
          row.about_landmark_label || null,
          row.about_landmark_text || null,
          row.about_subject_label || null,
          row.about_subject_text || null,
          row.interesting_fact || null,
          row.external_link || null,
          row.quiz_format || 'multiple_choice',
        ]
      );
      landmarkIdBySequence[row.sequence_order] = landmark.id;

      if (row.image_path) {
        await client.query(
          `INSERT INTO landmark_images (landmark_id, image_path, sort_order) VALUES ($1, $2, 0)`,
          [landmark.id, row.image_path]
        );
      }
      // sort_order 1: a separate crop suited to the landmark detail page's wide banner (roughly
      // 2:1) — the tile photo above is chosen/cropped for a square tile and often crops badly
      // at that aspect ratio instead.
      if (row.hero_image_path) {
        await client.query(
          `INSERT INTO landmark_images (landmark_id, image_path, sort_order) VALUES ($1, $2, 1)`,
          [landmark.id, row.hero_image_path]
        );
      }

      // The start landmark (no clue_type) has no gameplay — it's shown as already "found" from
      // the beginning, with no clue/puzzle/quiz rows to solve.
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

    // five_right is a single "question" made of many tile rows in the CSV (one per photo) —
    // group them back into one quiz_questions row per (landmark, question_order), same table/shape
    // as multiple_choice, just with a `tiles` array in answer_payload instead of `options`/`correct`.
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

    // anagram is one "question" per landmark (like five_right) — letters live in `scrambled`
    // (the starting board order, authored pre-scrambled) and `solution` (the correct order),
    // both just different orderings of the same letter multiset.
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

    if (recreateDevLocal) {
      await client.query(
        `INSERT INTO game_codes (code, tour_id, expires_at)
         VALUES ('DEV-LOCAL', $1, now() + interval '10 years')`,
        [tour.id]
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded '${tourCode}' (${tourName}): ${landmarks.length} landmarks, ${clueHints.length} hints, ${quizQuestions.length + fiveRightGroups.size + quizAnagram.length} quiz questions (${fiveRightGroups.size} five_right, ${quizAnagram.length} anagram), ${sites.length} sites.`);
    if (recreateDevLocal) console.log(`DEV-LOCAL recreated, pointing at '${tourCode}'.`);
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
