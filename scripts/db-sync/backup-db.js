// Layer 3 of the post-corruption backup system (see feedback_content_csv_safe_write_rule and
// project_edinburgh_poi_live_prod_rebuild memory for the incident this responds to).
//
// Layer 1 (scripts/lib/safe-write-csv.js) and Layer 2 (scripts/checkpoint-content.js) protect
// the CSV source-of-truth files. Neither protects the DATABASE itself - if a write to Postgres
// (e.g. scripts/db-sync/sync-content.js, or db/seed.js) goes wrong, the CSVs are fine but the
// live DB content is damaged with no way back. This script closes that gap: a read-only,
// point-in-time export of every CONTENT table (never INSTANCE tables - game_codes/games/teams/
// players/progress_events/messages/location_pings are live player data, not content, and are
// deliberately left untouched and unexported) to a timestamped JSON snapshot on disk.
//
// This is a snapshot, not a comparison - see reference_db_sync_tools for diff-content.js, which
// answers "does local match prod right now" instead. Convention: run this against prod
// immediately before any content push to prod (sync-content.js), so there's always a point-in-
// time backup to restore from if the push goes wrong. There is deliberately no automatic
// restore script - restoring is rare, high-stakes, and table-shape-dependent (e.g. landmarks
// must be restored by updating existing rows in place, not delete+reinsert, to avoid breaking
// progress_events FKs - see sync-content.js's upsertLandmarks for that exact problem). Restoring
// from a snapshot is a manual, reviewed job: read the relevant table(s) out of the snapshot
// JSON and write a one-off script for that specific restore, same as any other prod DB write.
//
// Usage:
//   node scripts/db-sync/backup-db.js                 back up local DB
//   DATABASE_URL=<prod-url> node scripts/db-sync/backup-db.js   back up prod DB
//   node scripts/db-sync/backup-db.js --label prod-pre-poi-push   custom label suffix

const fs = require('fs');
const path = require('path');
const { localPool, prodPool } = require('./connections');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_ROOT = path.join(PROJECT_ROOT, 'backups', 'db-snapshots');
const DEFAULT_RETENTION = 30;

// Full CONTENT section of the schema (see db/schema.sql) - everything above the INSTANCE
// section. Order matters for restore (parents before children via FK), not for backup itself,
// but kept in schema order for readability.
const CONTENT_TABLES = [
  'cities',
  'tours',
  'landmarks',
  'landmark_images',
  'clues',
  'clue_hints',
  'puzzles',
  'quiz_questions',
  'sites',
];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneOldSnapshots(dir, retention) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const excess = files.length - retention;
  if (excess > 0) {
    for (const f of files.slice(0, excess)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

async function backupTable(pool, table) {
  const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const labelIdx = args.indexOf('--label');
  const customLabel = labelIdx !== -1 ? args[labelIdx + 1] : null;

  const usingProd = !!process.env.DATABASE_URL;
  const pool = usingProd ? prodPool() : localPool();
  const dbLabel = customLabel || (usingProd ? 'prod' : 'local');

  console.error(`Backing up CONTENT tables from ${usingProd ? 'PROD' : 'local'} DB (label: ${dbLabel})...`);

  const snapshot = {
    label: dbLabel,
    source: usingProd ? 'prod' : 'local',
    takenAt: new Date().toISOString(),
    tables: {},
  };

  try {
    for (const table of CONTENT_TABLES) {
      const rows = await backupTable(pool, table);
      snapshot.tables[table] = rows;
      console.error(`  ${table}: ${rows.length} row(s)`);
    }
  } finally {
    await pool.end();
  }

  const dir = path.join(SNAPSHOT_ROOT, dbLabel);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  pruneOldSnapshots(dir, DEFAULT_RETENTION);

  console.error(`Snapshot written: ${path.relative(PROJECT_ROOT, file)}`);
}

main().catch((err) => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
