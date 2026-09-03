// Promotes rows from db/content/edinburgh-tour/POI-candidates.csv (the working file - see
// project-poi-creation-process-v2 memory) into db/content/edinburgh-tour/sites.csv, the
// DB-authoring staging file that `npm run seed` loads into Postgres.
//
// sites.csv has no per-leg column (the app always shows every curated site regardless of game
// progress - checked directly against server/index.js, not assumed), so this APPENDS the
// selected leg(s) to sites.csv's existing rows rather than overwriting it - each previously
// promoted leg's rows stay in place. Normal workflow: promote a leg, then archive+clear it out
// of POI-candidates.csv (see the archive step in project-poi-creation-process-v2 memory) - that
// discipline is what keeps a leg from ever being appended twice, not any dedup logic here.
//
// Usage: node db/promote-poi-candidates.js [--legs 1,2]
// Omit --legs to promote every leg currently in POI-candidates.csv.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CANDIDATES_PATH = path.join(__dirname, 'content/edinburgh-tour/POI-candidates.csv');
const SITES_PATH = path.join(__dirname, 'content/edinburgh-tour/sites.csv');

const legsArgIndex = process.argv.indexOf('--legs');
const requestedLegs = legsArgIndex !== -1 ? process.argv[legsArgIndex + 1].split(',').map(s => s.trim()) : null;

let rows = parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'), { columns: true, relax_quotes: true });
if (requestedLegs) rows = rows.filter(r => requestedLegs.includes(r.leg_number));

if (rows.length === 0) {
  console.error('No rows found in POI-candidates.csv' + (requestedLegs ? ' for leg(s) ' + requestedLegs.join(',') : '') + ' - nothing to promote.');
  process.exit(1);
}

// Mirrors the about_site_label mapping used elsewhere in this pipeline (db/poi-candidates-to-
// static.js, tools/poi-reader) - keep these three in sync by hand if this mapping ever changes.
const ABOUT_LABEL_BY_TYPE = {
  monument: 'About the monument', statue: 'About the statue',
  religious_building: 'About the church', history: 'About this address',
  building: 'About the building', architectural_point: 'About the building',
  plaque: 'About the plaque', viewpoint: 'About the view',
  recurring_feature: 'About this feature', museum: 'About the museum',
  gallery: 'About the gallery',
};

const cols = ['title', 'address', 'type', 'latitude', 'longitude', 'about_site_label', 'about_site_text', 'about_subject_label', 'about_subject_text', 'interesting_fact', 'image_path', 'external_link'];

function csvField(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

const newSiteRows = rows.map(r => ({
  title: r.name,
  address: r.address,
  type: r.type,
  latitude: r.latitude,
  longitude: r.longitude,
  about_site_label: ABOUT_LABEL_BY_TYPE[r.type] || 'About this spot',
  about_site_text: r.description,
  about_subject_label: '',
  about_subject_text: '',
  interesting_fact: r.interesting_fact,
  image_path: r.image_path,
  external_link: r.external_link,
}));

const existingSiteRows = fs.existsSync(SITES_PATH)
  ? parse(fs.readFileSync(SITES_PATH, 'utf8'), { columns: true, relax_quotes: true })
  : [];

const allSiteRows = [...existingSiteRows, ...newSiteRows];
const header = cols.join(',') + '\n';
const body = allSiteRows.map(r => cols.map(c => csvField(r[c])).join(',')).join('\n') + '\n';
fs.writeFileSync(SITES_PATH, header + body);

const legsUsed = [...new Set(rows.map(r => r.leg_number))].sort();
console.error(`Promoted ${newSiteRows.length} row(s) (leg(s) ${legsUsed.join(', ')}) into sites.csv - now ${allSiteRows.length} row(s) total.`);
