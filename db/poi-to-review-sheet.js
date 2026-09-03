// Converts db/content/edinburgh-tour/POI.csv into a ready-to-paste Apps Script function that
// loads a leg's data straight into the "Review" tab of the POI Field Review Google Sheet -
// no CSV paste, no File > Import, no external hosting. Both of those were tried and both
// silently failed to take effect (a tab-separated clipboard paste landed in one cell instead
// of splitting into columns; a File > Import didn't update the sheet either) - pasting a
// function into the Apps Script editor and clicking Run is the one mechanism that's proven
// reliable all session, so this reuses it instead of introducing a new failure-prone step.
//
// Row order becomes poi_number, so make sure POI.csv rows are already in the intended walking
// order before running this - poi_number is what the printed numbered map and the review app
// both key off.
//
// Usage:
//   node db/poi-to-review-sheet.js "RBS HQ -> Pitt Statue"            (pasteable Apps Script function)
//   node db/poi-to-review-sheet.js "RBS HQ -> Pitt Statue" --json      (prints {"rows": [...]} for
//                                                                       POSTing to ?action=loadReviewData)
//
// Default mode: paste the printed function into Code.gs in the Apps Script editor (alongside
// the existing functions, not replacing them), save, then select it from the function dropdown
// next to Run and click Run. Check View > Executions or the Logger output to confirm it loaded.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_PATH = path.join(__dirname, 'content/edinburgh-tour/POI.csv');
const legFilter = process.argv[2];

if (!legFilter) {
  console.error('Usage: node db/poi-to-review-sheet.js "<leg name>"');
  process.exit(1);
}

const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), { columns: true });
const filtered = rows.filter(r => r.leg === legFilter);

if (filtered.length === 0) {
  console.error(`No POI.csv rows found for leg "${legFilter}"`);
  process.exit(1);
}

const REVIEW_HEADERS = [
  'poi_number', 'name', 'type', 'address', 'about_site_label', 'description',
  'about_subject_label', 'about_subject_text', 'interesting_fact', 'source_notes', 'image_url',
  'existing_lat', 'existing_lon', 'geocode_confidence',
  'verdict', 'text_length', 'photo_choice', 'map_icon_correct', 'note_text',
  'new_gps_lat', 'new_gps_lon', 'new_gps_accuracy_m', 'new_photo_url', 'reviewed_at',
];

// image_path is normally a local server path (server/content-photos/...) which won't resolve
// from a phone loading the review page - only carry it over if it's already a public http(s)
// URL, same rule as before. A draft POI.csv row never has a real second ("about_subject")
// section - that's a promoted-site-only shape (see db/sites-to-review-sheet.js) - so those
// columns are always blank here.
const outRows = filtered.map((r, i) => {
  const imageUrl = /^https?:\/\//.test(r.image_path || '') ? r.image_path : '';
  return [
    i + 1, r.name, r.type, r.address, '', r.description, '', '', r.interesting_fact, r.source_notes,
    imageUrl, Number(r.latitude) || '', Number(r.longitude) || '', r.geocode_confidence,
    '', '', '', '', '', '', '', '', '', '',
  ];
});

// JSON.stringify per cell is the simplest way to safely embed arbitrary text (quotes,
// apostrophes, newlines) as a valid JS literal - numbers are left bare so the Sheet gets
// real numeric cells for poi_number/lat/lon, matching what typing them in by hand would give.
function jsLiteral(cell) {
  return typeof cell === 'number' ? String(cell) : JSON.stringify(cell == null ? '' : String(cell));
}

const allRows = [REVIEW_HEADERS, ...outRows];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows: allRows }));
} else {
  const rowsJs = allRows
    .map(row => '    [' + row.map(jsLiteral).join(', ') + ']')
    .join(',\n');

  const functionName = 'loadReviewData_' + legFilter.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  console.log(`// Generated from POI.csv leg "${legFilter}" - paste into Code.gs, Run once, then delete.
function ${functionName}() {
  const rows = [
${rowsJs}
  ];
  const sheet = getReviewSheet_();
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Loaded ' + (rows.length - 1) + ' row(s) into ' + REVIEW_SHEET_NAME);
}`);
}

const localImageRows = filtered.filter(r => r.image_path && !/^https?:\/\//.test(r.image_path));
if (localImageRows.length > 0) {
  console.error(`\nNote: ${localImageRows.length} row(s) have a local image_path, not a public URL - those will show with no photo in the review app until uploaded somewhere public and image_url is filled in by hand in the sheet afterward.`);
}
