// Shared helper for any script that overwrites a content CSV (sites.csv, landmarks.csv,
// POI-candidates.csv, etc). Before writing, snapshots the file's CURRENT on-disk content into
// backups/csv-snapshots/<path mirroring the file's location>/<timestamp>.csv, then performs the
// write. Keeps a rolling window of the most recent `retention` snapshots per file (oldest pruned
// automatically) - this is the direct fix for the 2026-09-21 Edinburgh POI corruption, where a
// buggy script silently overwrote sites.csv with no prior version recoverable anywhere.
//
// Usage: const { safeWriteFileSync } = require('./lib/safe-write-csv');
//        safeWriteFileSync(SITES_PATH, header + body);

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_ROOT = path.join(PROJECT_ROOT, 'backups', 'csv-snapshots');
const DEFAULT_RETENTION = 20;

function snapshotDirFor(filePath) {
  const relPath = path.relative(PROJECT_ROOT, path.resolve(filePath));
  return path.join(SNAPSHOT_ROOT, relPath);
}

function timestamp() {
  // Filesystem-safe ISO timestamp (colons/dots -> dashes). Lexical sort == chronological sort.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneOldSnapshots(dir, retention) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
  const excess = files.length - retention;
  if (excess > 0) {
    for (const f of files.slice(0, excess)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

// Snapshots filePath's current content (if it exists), prunes that file's snapshot folder down
// to `retention` entries, then writes newContent to filePath.
function safeWriteFileSync(filePath, newContent, { retention = DEFAULT_RETENTION } = {}) {
  if (fs.existsSync(filePath)) {
    const dir = snapshotDirFor(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(filePath, path.join(dir, `${timestamp()}.csv`));
    pruneOldSnapshots(dir, retention);
  }
  fs.writeFileSync(filePath, newContent);
}

module.exports = { safeWriteFileSync, snapshotDirFor };
