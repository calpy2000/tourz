// Converts db/content/edinburgh-tour/POI-candidates.csv (pre-promotion working file, see
// project-poi-creation-process-v2 memory) into tools/poi-field-review/pois-data.js - the static
// data file the field-review app reads (no Apps Script/Sheets in this pipeline any more).
//
// Unlike db/sites-to-review-sheet.js (which reads already-promoted sites.csv and has to guess
// geocode_confidence from scratch), POI-candidates.csv already carries real geocode_confidence
// and image_path values end-to-end, so this script is a much thinner mapping.
//
// Usage: node db/poi-candidates-to-static.js [--legs 1,2]
// Combines every leg listed in --legs into one continuous walk-through (geography-sorted
// together, numbered 1..N for that walk) - matches a real walk that covers multiple legs back
// to back in one outing. Omit --legs to include every leg currently in POI-candidates.csv.
// Each POI's image filename is stable ({leg_number}-{position within its own leg}.jpg, set once
// during desktop review) and does NOT change based on which legs get combined for a given walk -
// only the generated poiNumber (walk display order) is fresh each run.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_PATH = path.join(__dirname, 'content/edinburgh-tour/POI-candidates.csv');
const PHOTOS_DIR = path.join(__dirname, '..', 'server/content-photos');
const TEST_IMAGES_DIR = path.join(__dirname, '..', 'tools/poi-field-review/test-images');
const OUT_PATH = path.join(__dirname, '..', 'tools/poi-field-review/pois-data.js');

const legsArgIndex = process.argv.indexOf('--legs');
const requestedLegs = legsArgIndex !== -1 ? process.argv[legsArgIndex + 1].split(',').map(s => s.trim()) : null;

let rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), { columns: true, relax_quotes: true });
if (requestedLegs) rows = rows.filter(r => requestedLegs.includes(r.leg_number));

if (rows.length === 0) {
  console.error('No rows found in POI-candidates.csv' + (requestedLegs ? ' for leg(s) ' + requestedLegs.join(',') : ''));
  process.exit(1);
}

// One continuous walk: within each leg, rows are numbered in the order they already appear in
// POI-candidates.csv - each leg's rows are geography-sorted by hand at drafting time, and a leg
// with more than one physical route option (e.g. a detour that doubles back) relies on this exact
// row order to represent that, which a longitude/geography re-sort here cannot reproduce.
//
// ACROSS legs, though, a stable sort by leg_number is needed before numbering: rows for a given
// leg aren't always contiguous in the raw CSV (ad hoc additions - e.g. a grave POI added to leg 11
// in a later session - get appended at the end of the file, not spliced back into that leg's
// original block). Without this sort, the walk order would jump backwards geographically whenever
// that happens. `Array.prototype.sort` is stable in Node, so within a leg the original row order
// (and thus the geography-sort/detour logic above) is preserved exactly.
rows = rows.slice().sort((a, b) => Number(a.leg_number) - Number(b.leg_number));

// Mirrors the about_site_label mapping used at promotion time (see
// project-poi-sourcing-process memory) - what the real DetailPopup will show as the section
// label above the description. Extended with museum/gallery per this leg's new taxonomy.
const ABOUT_LABEL_BY_TYPE = {
  monument: 'About the monument', statue: 'About the statue',
  religious_building: 'About the church', history: 'About this address',
  building: 'About the building', architectural_point: 'About the building',
  plaque: 'About the plaque', viewpoint: 'About the view',
  recurring_feature: 'About this feature', museum: 'About the museum',
  gallery: 'About the gallery',
};

if (!fs.existsSync(TEST_IMAGES_DIR)) fs.mkdirSync(TEST_IMAGES_DIR, { recursive: true });

// legTotal per leg (for "POI M of N on this leg") - counted from the same `rows` the main map
// below iterates, so it always matches whatever legs/rows actually made it into this run.
const legTotals = {};
rows.forEach(r => { legTotals[r.leg_number] = (legTotals[r.leg_number] || 0) + 1; });
const legPositionCounters = {};

const copiedImages = [];
const missingImages = [];
const staticPois = rows.map((r, i) => {
  let imageUrl = '';
  if (r.image_path) {
    const srcPath = path.join(PHOTOS_DIR, r.image_path);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(TEST_IMAGES_DIR, r.image_path));
      imageUrl = 'test-images/' + r.image_path;
      copiedImages.push(r.image_path);
    } else {
      missingImages.push(r.image_path + ' (' + r.name + ')');
    }
  }
  legPositionCounters[r.leg_number] = (legPositionCounters[r.leg_number] || 0) + 1;
  return {
    poiNumber: i + 1,
    legNumber: Number(r.leg_number),
    legPosition: legPositionCounters[r.leg_number],
    legTotal: legTotals[r.leg_number],
    name: r.name,
    type: r.type,
    address: r.address,
    aboutSiteLabel: ABOUT_LABEL_BY_TYPE[r.type] || 'About this spot',
    description: r.description,
    aboutSubjectLabel: '',
    aboutSubjectText: '',
    interestingFact: r.interesting_fact,
    sourceNotes: r.source_notes,
    imageUrl: imageUrl,
    existingLat: Number(r.latitude) || null,
    existingLon: Number(r.longitude) || null,
    geocodeConfidence: r.geocode_confidence || 'approx - not independently verified',
  };
});

const header = `// Generated by \`node db/poi-candidates-to-static.js\` from POI-candidates.csv (${rows.length} rows) - do not hand-edit.\n// Regenerate and redeploy (git push) whenever POI-candidates.csv changes.\n`;
fs.writeFileSync(OUT_PATH, header + 'const POIS_DATA = ' + JSON.stringify(staticPois, null, 2) + ';\n');

const legsUsed = [...new Set(rows.map(r => r.leg_number))].sort();
console.error(`Wrote ${staticPois.length} POI(s) (leg(s) ${legsUsed.join(', ')}) to ${OUT_PATH}`);
console.error(`${copiedImages.length} image(s) copied into tools/poi-field-review/test-images/.`);
if (missingImages.length) {
  console.error(`${missingImages.length} row(s) reference a missing image file: ${missingImages.join(', ')}`);
}
