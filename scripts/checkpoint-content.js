// Layer 2 of the post-corruption backup system (see feedback_content_csv_safe_write_rule
// memory and project_edinburgh_poi_live_prod_rebuild for the incident this responds to).
//
// Layer 1 (scripts/lib/safe-write-csv.js) protects against a bad overwrite by snapshotting
// the previous file content locally before every write, but those snapshots are rolling and
// local-only. This script commits the actual content tree to git, which is durable, off-machine
// (once pushed) and unbounded history - a proper checkpoint, not a rolling window.
//
// Scope: db/content/**  (all tours' CSVs, tour.json, and the archive/ subfolders) and
// server/content-photos/** (landmark/POI images). One-off crisis-recovery artifacts that don't
// belong in the ongoing content pipeline (currently just db/content/edinburgh-db-backup-snapshot,
// from the 2026-09-21 incident) are explicitly excluded - those will move into a proper archive
// directory separately.
//
// This script only ever commits LOCALLY. It never pushes - see feedback_git_push_approval
// memory: git push always needs the user's explicit in-the-moment approval.
//
// Usage:
//   node scripts/checkpoint-content.js            commit staged content changes
//   node scripts/checkpoint-content.js --dry-run   show what would be staged/committed, no writes

const { execSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CONTENT_PATHS = ['db/content', 'server/content-photos'];
const EXCLUDE_PATHS = ['db/content/edinburgh-db-backup-snapshot'];

const dryRun = process.argv.includes('--dry-run');

function run(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' });
}

if (dryRun) {
  const status = run(`git status --porcelain -- ${CONTENT_PATHS.join(' ')}`);
  const lines = status.split('\n').filter(Boolean).filter(
    (l) => !EXCLUDE_PATHS.some((ex) => l.slice(3).startsWith(ex))
  );
  if (lines.length === 0) {
    console.error('[dry-run] No pending content changes - nothing would be committed.');
  } else {
    console.error(`[dry-run] Would stage and commit ${lines.length} change(s):`);
    lines.forEach((l) => console.error('  ' + l));
  }
  process.exit(0);
}

run(`git add -- ${CONTENT_PATHS.join(' ')}`);
for (const ex of EXCLUDE_PATHS) {
  try { run(`git reset -- "${ex}"`); } catch (e) { /* path may not exist / not staged */ }
}

const staged = run('git diff --cached --stat').trim();
if (!staged) {
  console.error('No pending content changes - nothing to commit.');
  process.exit(0);
}

const stagedFiles = run('git diff --cached --name-only').trim().split('\n').filter(Boolean);
const timestamp = new Date().toISOString();
const message = `Content checkpoint: ${timestamp} (${stagedFiles.length} file(s))\n\nAutomated checkpoint via scripts/checkpoint-content.js (Layer 2 of the backup system).\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`;

run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
console.error(`Committed ${stagedFiles.length} file(s) locally. Not pushed - push requires explicit approval.`);
console.error(staged);
