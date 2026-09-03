// Loads db/content/<tour-folder>/*.csv into the tourz database.
// Wipes and rebuilds the content tables each run — fine at this prototype stage
// where the CSVs are the source of truth and nothing else references this data yet.
// Re-run with: npm run seed

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');

const TOUR_FOLDER = 'edinburgh-tour';
const CITY_NAME = 'Edinburgh';
const TOUR_NAME = 'Edinburgh Old Town Walk'; // placeholder — trivial to rename later

const contentDir = path.join(__dirname, 'content', TOUR_FOLDER);

function readCsv(filename) {
  const filePath = path.join(contentDir, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

// Converts the flat CSV puzzle/quiz columns into the JSONB answer_payload shape
// the schema expects. Convention: exact_numeric -> {answer}, fuzzy_text -> {accepted:[]},
// multiple_choice -> {options:[], correct}.
function puzzleAnswerPayload(type, answer) {
  if (type === 'exact_numeric') return { answer };
  if (type === 'fuzzy_text') return { accepted: [answer] };
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

async function main() {
  const landmarks = readCsv('landmarks.csv');
  const clueHints = readCsv('clue_hints.csv');
  const quizQuestions = readCsv('quiz_questions.csv');
  const sites = readCsv('sites.csv');

  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    database: 'tourz',
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Wipe content tables (cascades to landmark_images/clues/clue_hints/puzzles/quiz_questions/sites)
    await client.query('TRUNCATE cities, tours RESTART IDENTITY CASCADE');

    const { rows: [city] } = await client.query(
      'INSERT INTO cities (name) VALUES ($1) RETURNING id',
      [CITY_NAME]
    );
    const { rows: [tour] } = await client.query(
      'INSERT INTO tours (city_id, name, total_landmarks) VALUES ($1, $2, $3) RETURNING id',
      [city.id, TOUR_NAME, landmarks.length]
    );

    const landmarkIdBySequence = {};
    const clueIdBySequence = {};

    for (const row of landmarks) {
      const { rows: [landmark] } = await client.query(
        `INSERT INTO landmarks
           (tour_id, sequence_order, title, address, latitude, longitude,
            about_landmark_label, about_landmark_text, about_subject_label, about_subject_text,
            interesting_fact, external_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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

    await client.query('COMMIT');
    console.log(`Seeded ${landmarks.length} landmarks, ${clueHints.length} hints, ${quizQuestions.length} quiz questions, ${sites.length} sites.`);
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
