// Shared load/re-serialize helper for any script that edits rows in a content CSV
// (landmarks.csv, sites.csv, POI-candidates.csv, ...). Exists because promote-poi-candidates.js
// and archive-leg.js are the only scripts with a fixed home to wire safe-write-csv into directly -
// landmarks.csv has no such central script, it's always edited by a fresh one-off script written
// per edit. Using loadCsvRows/writeCsvRowsSafely here instead of hand-rolling fs.readFileSync/
// csv-parse/fs.writeFileSync in every one-off script routes EVERY content-CSV write through the
// same safeWriteFileSync pre-write snapshot, regardless of which file or script is involved.
//
// Usage in a one-off edit script:
//   const { loadCsvRows, writeCsvRowsSafely } = require('../scripts/lib/edit-csv-row');
//   const rows = loadCsvRows(LANDMARKS_PATH);
//   // ...mutate the one row you need...
//   writeCsvRowsSafely(LANDMARKS_PATH, rows, COLUMNS); // COLUMNS = the file's real header list,
//                                                        // in order - copy it from the CSV's own
//                                                        // first line, don't guess it by hand.

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { safeWriteFileSync } = require('./safe-write-csv');

function loadCsvRows(filePath) {
  return parse(fs.readFileSync(filePath, 'utf8'), { columns: true, relax_quotes: true });
}

function csvField(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

// Re-serializes `rows` using the exact `columns` list (order matters - must match the file's
// real header) and writes the result through safeWriteFileSync.
function writeCsvRowsSafely(filePath, rows, columns, options) {
  const header = columns.join(',') + '\n';
  const body = rows.map((r) => columns.map((c) => csvField(r[c])).join(',')).join('\n') + (rows.length ? '\n' : '');
  safeWriteFileSync(filePath, header + body, options);
}

module.exports = { loadCsvRows, writeCsvRowsSafely, csvField };
