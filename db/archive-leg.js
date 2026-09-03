// Archives one leg's rows out of db/content/edinburgh-tour/POI-candidates.csv into an immutable
// snapshot, then removes just that leg's rows from the working file - other legs still in
// progress in the same file are left untouched. Run this right after promoting a leg (see
// db/promote-poi-candidates.js and the project-poi-creation-process-v2 memory) so the working
// file doesn't grow unboundedly and the POI Reader / POI Drafts map layer stay scoped to what's
// actually still being worked on.
//
// Usage: node db/archive-leg.js <leg_number>
// Writes db/content/edinburgh-tour/archive/POI-candidates-leg<N>-promoted-<date>.csv

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const legNumber = process.argv[2];
if (!legNumber) {
  console.error('Usage: node db/archive-leg.js <leg_number>');
  process.exit(1);
}

const CANDIDATES_PATH = path.join(__dirname, 'content/edinburgh-tour/POI-candidates.csv');
const ARCHIVE_DIR = path.join(__dirname, 'content/edinburgh-tour/archive');

const rows = parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'), { columns: true, relax_quotes: true });
const legRows = rows.filter(r => r.leg_number === legNumber);
const remainingRows = rows.filter(r => r.leg_number !== legNumber);

if (legRows.length === 0) {
  console.error(`No rows found for leg_number "${legNumber}" - nothing to archive.`);
  process.exit(1);
}

const cols = ['leg', 'leg_number', 'name', 'type', 'address', 'on_route', 'distance_from_route_m', 'interest_rating', 'description', 'interesting_fact', 'external_link', 'source_notes', 'latitude', 'longitude', 'geocode_confidence', 'image_path', 'verdict', 'text_length', 'photo_choice', 'map_icon_correct', 'note_text', 'new_gps_lat', 'new_gps_lon', 'new_gps_accuracy_m', 'reviewed_at'];
function csvField(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}
const header = cols.join(',') + '\n';

if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
const dateStr = new Date().toISOString().slice(0, 10);
const archivePath = path.join(ARCHIVE_DIR, `POI-candidates-leg${legNumber}-promoted-${dateStr}.csv`);
const archiveBody = legRows.map(r => cols.map(c => csvField(r[c])).join(',')).join('\n') + '\n';
fs.writeFileSync(archivePath, header + archiveBody);

const remainingBody = remainingRows.map(r => cols.map(c => csvField(r[c])).join(',')).join('\n') + (remainingRows.length ? '\n' : '');
fs.writeFileSync(CANDIDATES_PATH, header + remainingBody);

console.error(`Archived ${legRows.length} row(s) for leg ${legNumber} to ${archivePath}`);
console.error(`POI-candidates.csv now has ${remainingRows.length} row(s) remaining.`);
