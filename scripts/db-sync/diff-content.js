// Compares every CONTENT table (the static, admin-authored tables defined in db/schema.sql —
// landmarks, landmark_images, clues, clue_hints, puzzles, quiz_questions, sites) between the
// local dev DB and the live prod DB, row by row, keyed by a natural key (never by `id`, since
// ids are assigned independently by each DB's own sequence). Never touches INSTANCE tables
// (game_codes, games, teams, players, progress_events, messages, location_pings) — those are
// expected to differ and reseeding/syncing them would destroy real player data.
//
// Read-only. Run with: node scripts/db-sync/diff-content.js
// Pair with sync-content.js to apply fixes once you've reviewed the report.
const { localPool, prodPool } = require('./connections');

function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const TABLES = [
  {
    name: 'landmarks',
    query: `SELECT sequence_order, title, address, latitude, longitude,
                    about_landmark_label, about_landmark_text, about_subject_label,
                    about_subject_text, interesting_fact, external_link, quiz_format
             FROM landmarks ORDER BY sequence_order`,
    key: (r) => `${r.sequence_order}`,
    fields: ['title', 'address', 'latitude', 'longitude', 'about_landmark_label',
      'about_landmark_text', 'about_subject_label', 'about_subject_text',
      'interesting_fact', 'external_link', 'quiz_format'],
  },
  {
    name: 'landmark_images',
    query: `SELECT landmarks.sequence_order, landmark_images.sort_order, landmark_images.image_path
             FROM landmark_images JOIN landmarks ON landmark_images.landmark_id = landmarks.id
             ORDER BY landmarks.sequence_order, landmark_images.sort_order`,
    key: (r) => `${r.sequence_order}:${r.sort_order}`,
    fields: ['image_path'],
  },
  {
    name: 'clues',
    query: `SELECT landmarks.sequence_order, clues.type, clues.clue_text
             FROM clues JOIN landmarks ON clues.landmark_id = landmarks.id
             ORDER BY landmarks.sequence_order`,
    key: (r) => `${r.sequence_order}`,
    fields: ['type', 'clue_text'],
  },
  {
    name: 'clue_hints',
    query: `SELECT landmarks.sequence_order, clue_hints.hint_order, clue_hints.hint_text
             FROM clue_hints
             JOIN clues ON clue_hints.clue_id = clues.id
             JOIN landmarks ON clues.landmark_id = landmarks.id
             ORDER BY landmarks.sequence_order, clue_hints.hint_order`,
    key: (r) => `${r.sequence_order}:${r.hint_order}`,
    fields: ['hint_text'],
  },
  {
    name: 'puzzles',
    query: `SELECT landmarks.sequence_order, puzzles.type, puzzles.question_text,
                    puzzles.answer_payload, puzzles.explanation
             FROM puzzles JOIN landmarks ON puzzles.landmark_id = landmarks.id
             ORDER BY landmarks.sequence_order`,
    key: (r) => `${r.sequence_order}`,
    fields: ['type', 'question_text', 'answer_payload', 'explanation'],
  },
  {
    name: 'quiz_questions',
    query: `SELECT landmarks.sequence_order AS landmark_seq, quiz_questions.sequence_order AS q_seq,
                    quiz_questions.type, quiz_questions.question_text,
                    quiz_questions.answer_payload, quiz_questions.explanation, quiz_questions.points
             FROM quiz_questions JOIN landmarks ON quiz_questions.landmark_id = landmarks.id
             ORDER BY landmark_seq, q_seq`,
    key: (r) => `${r.landmark_seq}:${r.q_seq}`,
    fields: ['type', 'question_text', 'answer_payload', 'explanation', 'points'],
  },
  {
    name: 'sites',
    query: `SELECT title, address, type, latitude, longitude,
                    about_site_label, about_site_text, about_subject_label, about_subject_text,
                    interesting_fact, image_path, external_link
             FROM sites ORDER BY title`,
    key: (r) => r.title,
    fields: ['address', 'type', 'latitude', 'longitude', 'about_site_label', 'about_site_text',
      'about_subject_label', 'about_subject_text', 'interesting_fact', 'image_path', 'external_link'],
  },
];

async function fetchRows(pool, table) {
  const { rows } = await pool.query(table.query);
  const map = new Map();
  for (const row of rows) map.set(table.key(row), row);
  return map;
}

function fieldsDiffer(a, b, field) {
  const av = a[field];
  const bv = b[field];
  if (field === 'answer_payload') return !jsonEq(av, bv);
  return String(av ?? '') !== String(bv ?? '');
}

async function main() {
  const local = localPool();
  const prod = prodPool();
  const report = { missingFromProd: [], extraInProd: [], mismatched: [] };

  try {
    for (const table of TABLES) {
      const [localRows, prodRows] = await Promise.all([fetchRows(local, table), fetchRows(prod, table)]);
      const allKeys = new Set([...localRows.keys(), ...prodRows.keys()]);

      for (const key of allKeys) {
        const localRow = localRows.get(key);
        const prodRow = prodRows.get(key);

        if (localRow && !prodRow) {
          report.missingFromProd.push({ table: table.name, key });
          continue;
        }
        if (!localRow && prodRow) {
          report.extraInProd.push({ table: table.name, key });
          continue;
        }

        const diffs = table.fields
          .filter((field) => fieldsDiffer(localRow, prodRow, field))
          .map((field) => ({
            field,
            local: field === 'answer_payload' ? JSON.stringify(localRow[field]) : localRow[field],
            prod: field === 'answer_payload' ? JSON.stringify(prodRow[field]) : prodRow[field],
          }));

        if (diffs.length > 0) {
          report.mismatched.push({ table: table.name, key, diffs });
        }
      }
    }

    if (
      report.missingFromProd.length === 0 &&
      report.extraInProd.length === 0 &&
      report.mismatched.length === 0
    ) {
      console.log('No differences — local and prod content tables match.');
      return;
    }

    if (report.missingFromProd.length > 0) {
      console.log(`\n=== Rows in local but MISSING from prod (${report.missingFromProd.length}) ===`);
      for (const r of report.missingFromProd) console.log(`  ${r.table} [${r.key}]`);
    }

    if (report.extraInProd.length > 0) {
      console.log(`\n=== Rows in prod but NOT in local (${report.extraInProd.length}) — review before deleting ===`);
      for (const r of report.extraInProd) console.log(`  ${r.table} [${r.key}]`);
    }

    if (report.mismatched.length > 0) {
      console.log(`\n=== Rows present in both but with differing content (${report.mismatched.length}) ===`);
      for (const r of report.mismatched) {
        console.log(`  ${r.table} [${r.key}]`);
        for (const d of r.diffs) {
          console.log(`    ${d.field}:`);
          console.log(`      local: ${JSON.stringify(d.local)}`);
          console.log(`      prod:  ${JSON.stringify(d.prod)}`);
        }
      }
    }

    console.log(`\nTotals: ${report.missingFromProd.length} missing, ${report.extraInProd.length} extra, ${report.mismatched.length} mismatched.`);
  } finally {
    await local.end();
    await prod.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
