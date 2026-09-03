// Converts db/content/edinburgh-tour/sites.csv (already-promoted, live-in-game content) into
// data for the POI field-review tool - for field-verifying content that's already shipped, as
// opposed to db/poi-to-review-sheet.js which converts still-draft POI.csv rows before promotion.
//
// sites.csv has no per-leg column, so this converts the whole file - fine while only one leg
// (RBS HQ -> Pitt Statue) has been promoted; once a second leg's sites exist alongside it,
// this will need a way to scope to just one leg's rows.
//
// Any row's image_path that exists as a real file in server/content-photos/ gets copied into
// tools/poi-field-review/test-images/ automatically (same convention already used for The Dome
// and Melville Monument earlier this session) so the preview can actually show it - most rows
// currently have no image_path at all, which is real: most of leg 1's POIs don't have a
// sourced photo yet (see project-poi-sourcing-process memory, lesson 4 - images are sourced
// after curation, not before).
//
// Usage:
//   node db/sites-to-review-sheet.js             (prints a pasteable Apps Script function - legacy,
//                                                  the live app no longer uses Apps Script/Sheets)
//   node db/sites-to-review-sheet.js --json       (prints {"rows": [...]} - legacy, same reason)
//   node db/sites-to-review-sheet.js --static     (writes tools/poi-field-review/pois-data.js -
//                                                  the static data file the field-review app
//                                                  actually reads today; re-run this and redeploy
//                                                  whenever sites.csv changes)
//
// Default mode: paste the printed function into Code.gs in the Apps Script editor (alongside
// the existing functions, not replacing them), save, select it from the function dropdown next
// to Run, click Run, then delete it if you like (harmless to leave too).

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_PATH = path.join(__dirname, 'content/edinburgh-tour/sites.csv');
const PHOTOS_DIR = path.join(__dirname, '..', 'server/content-photos');
const TEST_IMAGES_DIR = path.join(__dirname, '..', 'tools/poi-field-review/test-images');

const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), { columns: true });

if (rows.length === 0) {
  console.error('No rows found in sites.csv');
  process.exit(1);
}

// sites.csv carries no geocode_confidence column (that field only exists on draft POI.csv rows,
// pre-promotion - the original values for these 27 rows were lost when POI.csv was cleared
// after promotion, an intentional step in the process, see project-poi-field-verification-tools
// memory). Recreated here from scratch by judgment, not recovered - a well-documented
// listed building/landmark gets "confirmed", an address-only residence, small quirky detail, or
// explicitly-unverified feature gets "approx" with a real reason. Exact match to the lost
// originals doesn't matter for this purpose (the user just wants realistic confirmed/approx
// variety to test the confidence-indicator UI against, not a byte-for-byte recovery).
const CONFIDENCE_BY_NAME = {
  'The Dome': 'confirmed',
  'Melville Monument': 'confirmed',
  'Lion of Scotland': 'confirmed',
  'Paddington Bear Statue': 'approx - temporary public art installation, no official permanent listing found',
  'King George IV Statue': 'confirmed',
  "St Andrew's and St George's West Church": 'confirmed',
  "Susan Ferrier's Home": 'approx - based on street address only, no additional marker confirmed',
  'Royal Society of Edinburgh': 'confirmed',
  'Caledonian Insurance Building': 'confirmed',
  'The Preserved Vintage Optician': 'approx - based on street address only',
  'The Assembly Rooms': 'confirmed',
  'Pink Sandstone Among Yellow Free-Stone': 'approx - based on street address only',
  'Frederick Street Castle View': 'approx - viewpoint at a junction, not a fixed single location',
  "David Hume's House (plaque)": 'confirmed',
  'Thistle Court': 'confirmed',
  "Site of Madame Tussaud's first Edinburgh exhibition": 'confirmed',
  'Rose Street Pub Row': 'approx - general stretch of street, not a fixed single location',
  'Hidden Back-Lane White Tiles': 'approx - unverified, no confirmed physical instance found yet',
  'Former British Linen Bank HQ': 'confirmed',
  "Lord Henry Brougham's Birthplace": 'confirmed',
  "Sir William Chambers's Residence": 'approx - address only, exact building not independently confirmed',
  'The Former US Consulate': 'confirmed',
  'The Giant Caryatids': 'confirmed',
  'Home of Eugene Chantrelle': 'approx - based on street address only, no additional marker confirmed',
  'Micro-Lighthouse Above the Doorway': 'confirmed',
  "Freemasons' Hall": 'confirmed',
  'Early Modernist Steel Anomaly': 'approx - building history sparsely documented online, address-based estimate',
};

if (!fs.existsSync(TEST_IMAGES_DIR)) fs.mkdirSync(TEST_IMAGES_DIR, { recursive: true });

const REVIEW_HEADERS = [
  'poi_number', 'name', 'type', 'address', 'about_site_label', 'description',
  'about_subject_label', 'about_subject_text', 'interesting_fact', 'source_notes', 'image_url',
  'existing_lat', 'existing_lon', 'geocode_confidence',
  'verdict', 'text_length', 'photo_choice', 'map_icon_correct', 'note_text',
  'new_gps_lat', 'new_gps_lon', 'new_gps_accuracy_m', 'new_photo_url', 'reviewed_at',
];

const copiedImages = [];
const outRows = rows.map((r, i) => {
  let imageUrl = '';
  if (r.image_path) {
    const srcPath = path.join(PHOTOS_DIR, r.image_path);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(TEST_IMAGES_DIR, r.image_path));
      imageUrl = 'test-images/' + r.image_path;
      copiedImages.push(r.image_path);
    }
  }
  const confidence = CONFIDENCE_BY_NAME[r.title] || 'approx - not independently verified';
  return [
    i + 1, r.title, r.type, r.address, r.about_site_label, r.about_site_text,
    r.about_subject_label, r.about_subject_text, r.interesting_fact, '', imageUrl,
    Number(r.latitude) || '', Number(r.longitude) || '', confidence,
    '', '', '', '', '', '', '', '', '', '',
  ];
});

const allRows = [REVIEW_HEADERS, ...outRows];

if (process.argv.includes('--static')) {
  // Shape matches exactly what the old getPois() endpoint returned - camelCase objects, one
  // per POI - so index.html's rendering code (which reads p.poiNumber/p.aboutSiteLabel/etc.)
  // needed zero changes beyond how this data gets loaded in.
  const staticPois = rows.map((r, i) => {
    let imageUrl = '';
    if (r.image_path) {
      const srcPath = path.join(PHOTOS_DIR, r.image_path);
      if (fs.existsSync(srcPath)) imageUrl = 'test-images/' + r.image_path;
    }
    return {
      poiNumber: i + 1,
      name: r.title,
      type: r.type,
      address: r.address,
      aboutSiteLabel: r.about_site_label,
      description: r.about_site_text,
      aboutSubjectLabel: r.about_subject_label,
      aboutSubjectText: r.about_subject_text,
      interestingFact: r.interesting_fact,
      sourceNotes: '',
      imageUrl: imageUrl,
      existingLat: Number(r.latitude) || null,
      existingLon: Number(r.longitude) || null,
      geocodeConfidence: CONFIDENCE_BY_NAME[r.title] || 'approx - not independently verified',
    };
  });
  const outPath = path.join(__dirname, '..', 'tools/poi-field-review/pois-data.js');
  const header = `// Generated by \`node db/sites-to-review-sheet.js --static\` from sites.csv (${rows.length} rows) - do not hand-edit.\n// Regenerate and redeploy (git push) whenever sites.csv changes.\n`;
  fs.writeFileSync(outPath, header + 'const POIS_DATA = ' + JSON.stringify(staticPois, null, 2) + ';\n');
  console.error(`Wrote ${staticPois.length} POI(s) to ${outPath}`);
  process.exit(0);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows: allRows }));
} else {
  function jsLiteral(cell) {
    return typeof cell === 'number' ? String(cell) : JSON.stringify(cell == null ? '' : String(cell));
  }
  const rowsJs = allRows
    .map(row => '    [' + row.map(jsLiteral).join(', ') + ']')
    .join(',\n');

  console.log(`// Generated from sites.csv (all ${rows.length} promoted, live-in-game rows) - paste into Code.gs, Run once, then delete.
function loadReviewData_sites() {
  const rows = [
${rowsJs}
  ];
  const sheet = getReviewSheet_();
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Loaded ' + (rows.length - 1) + ' row(s) into ' + REVIEW_SHEET_NAME);
}`);
}

console.error(`\n${copiedImages.length} of ${rows.length} row(s) have a real photo, copied into tools/poi-field-review/test-images/: ${copiedImages.join(', ')}`);
console.error(`Remaining ${rows.length - copiedImages.length} row(s) have no sourced photo yet - real gap, not a bug.`);
