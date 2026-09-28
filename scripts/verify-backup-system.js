// Periodic health check for the 3-layer content backup system (see
// project_backup_system_status memory). Read-only - never writes, commits, or pushes anything.
// Run this from time to time (e.g. after a batch of content edits or before/after a prod push)
// instead of writing a fresh one-off check script each time.
//
// Layer 1 - scripts/lib/safe-write-csv.js: rolling local CSV snapshots in backups/csv-snapshots/
// Layer 2 - scripts/checkpoint-content.js: durable git history of db/content + content-photos
// Layer 3 - scripts/db-sync/backup-db.js: rolling point-in-time DB JSON snapshots
//
// Usage:
//   node scripts/verify-backup-system.js            checks local DB only (fast, always safe)
//   node scripts/verify-backup-system.js --prod      also live-counts prod DB content tables

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CSV_SNAPSHOT_ROOT = path.join(REPO_ROOT, 'backups', 'csv-snapshots');
const DB_SNAPSHOT_ROOT = path.join(REPO_ROOT, 'backups', 'db-snapshots');
const CSV_RETENTION = 20;
const DB_RETENTION = 30;
const STALE_DB_SNAPSHOT_DAYS = 7;

const CONTENT_TABLES = [
  'cities', 'tours', 'landmarks', 'landmark_images', 'clues', 'clue_hints',
  'puzzles', 'quiz_questions', 'sites',
];

const results = { ok: [], warn: [], fail: [] };
function ok(msg) { results.ok.push(msg); }
function warn(msg) { results.warn.push(msg); }
function fail(msg) { results.fail.push(msg); }

function run(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

// ---------- Layer 1: CSV snapshots ----------
function checkLayer1() {
  console.log('\n=== Layer 1: CSV snapshots (scripts/lib/safe-write-csv.js) ===');

  if (!fs.existsSync(CSV_SNAPSHOT_ROOT)) {
    fail('backups/csv-snapshots/ does not exist');
    return;
  }

  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  if (/^backups\/?$/m.test(gitignore) || gitignore.includes('backups/')) {
    ok('backups/ is gitignored (snapshots stay local, as intended)');
  } else {
    fail('backups/ is NOT in .gitignore - snapshot churn could get committed');
  }

  const realCsvs = walk(path.join(REPO_ROOT, 'db', 'content'), (n) => n.endsWith('.csv'));
  const realCsvRelPaths = new Set(realCsvs.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/')));

  const snapshotDirs = walk(CSV_SNAPSHOT_ROOT, () => true)
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => path.dirname(f));
  const uniqueDirs = [...new Set(snapshotDirs)];

  let overRetention = 0;
  let orphans = 0;
  let mostRecentAny = null;

  for (const dir of uniqueDirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
    if (files.length > CSV_RETENTION) {
      overRetention++;
      warn(`${path.relative(REPO_ROOT, dir)} has ${files.length} snapshots (retention is ${CSV_RETENTION}) - pruning may not be running`);
    }
    const relToSnapshotRoot = path.relative(CSV_SNAPSHOT_ROOT, dir);
    if (!realCsvRelPaths.has(relToSnapshotRoot.replace(/\\/g, '/'))) {
      orphans++;
    }
    const last = files[files.length - 1];
    if (last) {
      const mtime = fs.statSync(path.join(dir, last)).mtime;
      if (!mostRecentAny || mtime > mostRecentAny) mostRecentAny = mtime;
      // spot-check the most recent snapshot is a readable, non-empty CSV
      const content = fs.readFileSync(path.join(dir, last), 'utf8');
      if (!content.trim() || !content.includes(',')) {
        fail(`${path.relative(REPO_ROOT, path.join(dir, last))} looks corrupt (empty or no commas)`);
      }
    }
  }

  ok(`${uniqueDirs.length} CSV(s) have at least one snapshot, ${realCsvs.length} real content CSVs exist`);
  if (overRetention === 0) ok(`all snapshot folders within retention (<=${CSV_RETENTION})`);
  if (orphans > 0) {
    warn(`${orphans} snapshot folder(s) don't correspond to a currently-existing content CSV (likely leftover test/renamed-file artifacts - harmless clutter, safe to delete manually if desired)`);
  }

  // Empty leaf directories (e.g. from a past ad hoc test of safe-write-csv.js) hold no files,
  // so they never show up in the file-based walk above - check for them separately.
  const emptyDirs = [];
  (function findEmptyDirs(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory());
    if (entries.length === 0) { emptyDirs.push(dir); return; }
    subdirs.forEach((e) => findEmptyDirs(path.join(dir, e.name)));
  })(CSV_SNAPSHOT_ROOT);
  if (emptyDirs.length > 0) {
    warn(`${emptyDirs.length} empty leftover snapshot folder(s) (harmless clutter, safe to delete manually): ` +
      emptyDirs.map((d) => path.relative(REPO_ROOT, d)).join(', '));
  }
  if (mostRecentAny) {
    ok(`most recent CSV snapshot: ${mostRecentAny.toISOString()}`);
  }
}

// ---------- Layer 2: git checkpoint ----------
function checkLayer2() {
  console.log('\n=== Layer 2: git checkpoint (scripts/checkpoint-content.js) ===');

  if (!fs.existsSync(path.join(REPO_ROOT, 'scripts', 'checkpoint-content.js'))) {
    fail('scripts/checkpoint-content.js is missing');
    return;
  }

  const status = run('git status --porcelain -- db/content server/content-photos').trim();
  const pending = status ? status.split('\n').filter(Boolean) : [];
  if (pending.length === 0) {
    ok('no uncommitted changes under db/content or server/content-photos - fully checkpointed');
  } else {
    warn(`${pending.length} uncommitted change(s) under db/content or server/content-photos (not yet durable in git):`);
    pending.forEach((l) => warn('  ' + l));
  }

  // execFileSync (no shell) avoids cmd.exe on Windows trying to expand %H/%ci/%s as env vars.
  let lastCommitLine;
  try {
    lastCommitLine = execFileSync('git', [
      'log', '-1', '--format=%H|%ci|%s', '--', 'db/content', 'server/content-photos',
    ], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    lastCommitLine = '';
  }
  if (!lastCommitLine) {
    fail('no git history at all touching db/content or server/content-photos');
    return;
  }
  const [hash, date, subject] = lastCommitLine.split('|');
  ok(`last commit touching content: ${date} - "${subject}" (${hash.slice(0, 7)})`);

  const daysSince = (Date.now() - new Date(date).getTime()) / 86400000;
  if (daysSince > 14) {
    warn(`last content commit was ${daysSince.toFixed(1)} days ago - confirm that's expected (no untracked edits sitting around)`);
  }
}

// ---------- Layer 3: DB snapshots ----------
function checkLayer3Files() {
  console.log('\n=== Layer 3: DB snapshots (scripts/db-sync/backup-db.js) ===');

  const snapshots = {};
  if (!fs.existsSync(DB_SNAPSHOT_ROOT)) {
    fail('backups/db-snapshots/ does not exist');
    return snapshots;
  }

  const labelDirs = fs.readdirSync(DB_SNAPSHOT_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);

  if (!labelDirs.includes('local')) warn('no backups/db-snapshots/local/ folder yet (run backup-db.js locally at least once)');
  if (!labelDirs.includes('prod')) warn('no backups/db-snapshots/prod/ folder yet (run backup-db.js against prod before the next prod push)');

  for (const label of labelDirs) {
    const dir = path.join(DB_SNAPSHOT_ROOT, label);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) {
      warn(`${label}: no snapshot files`);
      continue;
    }
    if (files.length > DB_RETENTION) {
      warn(`${label}: ${files.length} snapshots (retention is ${DB_RETENTION}) - pruning may not be running`);
    }
    const latestFile = path.join(dir, files[files.length - 1]);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    } catch (e) {
      fail(`${label}: latest snapshot (${files[files.length - 1]}) is not valid JSON: ${e.message}`);
      continue;
    }
    const missingTables = CONTENT_TABLES.filter((t) => !(t in (parsed.tables || {})));
    if (missingTables.length > 0) {
      fail(`${label}: latest snapshot is missing table(s): ${missingTables.join(', ')}`);
    } else {
      ok(`${label}: latest snapshot has all ${CONTENT_TABLES.length} content tables`);
    }

    const takenAt = new Date(parsed.takenAt || fs.statSync(latestFile).mtime);
    const ageDays = (Date.now() - takenAt.getTime()) / 86400000;
    const counts = {};
    for (const t of CONTENT_TABLES) counts[t] = (parsed.tables && parsed.tables[t] || []).length;
    console.log(`  ${label}: taken ${takenAt.toISOString()} (${ageDays.toFixed(1)}d ago), rows: ${JSON.stringify(counts)}`);

    if (ageDays > STALE_DB_SNAPSHOT_DAYS) {
      warn(`${label}: latest snapshot is ${ageDays.toFixed(1)} days old (>${STALE_DB_SNAPSHOT_DAYS}d) - consider taking a fresh one, especially before the next push to that DB`);
    } else {
      ok(`${label}: latest snapshot is recent (${ageDays.toFixed(1)}d old)`);
    }

    snapshots[label] = { counts, takenAt };
  }

  return snapshots;
}

async function checkLayer3Live(snapshots, includeProd) {
  let localPool, prodPool;
  try {
    ({ localPool, prodPool } = require('./db-sync/connections'));
  } catch (e) {
    warn(`could not load db-sync/connections.js to live-check DB counts: ${e.message}`);
    return;
  }

  async function liveCounts(pool, label) {
    const client = await pool.connect();
    try {
      const counts = {};
      for (const t of CONTENT_TABLES) {
        const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        counts[t] = rows[0].n;
      }
      return counts;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async function compare(label, pool) {
    let live;
    try {
      live = await liveCounts(pool, label);
    } catch (e) {
      warn(`${label}: could not live-query DB to compare against snapshot: ${e.message}`);
      return;
    }
    console.log(`  ${label} live row counts: ${JSON.stringify(live)}`);
    const snap = snapshots[label];
    if (!snap) {
      warn(`${label}: no snapshot to compare live counts against`);
      return;
    }
    const drifted = CONTENT_TABLES.filter((t) => snap.counts[t] !== live[t]);
    if (drifted.length === 0) {
      ok(`${label}: live DB row counts match latest snapshot exactly - snapshot is current`);
    } else {
      warn(`${label}: live DB has drifted from latest snapshot in ${drifted.length} table(s) (expected if content changed since the snapshot was taken): ` +
        drifted.map((t) => `${t} snap=${snap.counts[t]} live=${live[t]}`).join(', '));
    }
  }

  await compare('local', localPool());
  if (includeProd) await compare('prod', prodPool());
}

async function main() {
  const includeProd = process.argv.includes('--prod');

  console.log('Backup system health check - ' + new Date().toISOString());

  checkLayer1();
  checkLayer2();
  const snapshots = checkLayer3Files();
  console.log('\n--- live DB row counts (read-only) ---');
  await checkLayer3Live(snapshots, includeProd);
  if (!includeProd) console.log('  (prod skipped - pass --prod to also live-check prod)');

  console.log('\n=== Summary ===');
  console.log(`OK: ${results.ok.length}, WARN: ${results.warn.length}, FAIL: ${results.fail.length}`);
  if (results.warn.length) {
    console.log('\nWarnings:');
    results.warn.forEach((w) => console.log('  [WARN] ' + w));
  }
  if (results.fail.length) {
    console.log('\nFailures:');
    results.fail.forEach((f) => console.log('  [FAIL] ' + f));
  }
  if (!results.warn.length && !results.fail.length) {
    console.log('\nAll 3 backup layers look healthy.');
  }

  process.exit(results.fail.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-backup-system.js crashed:', err);
  process.exit(2);
});
