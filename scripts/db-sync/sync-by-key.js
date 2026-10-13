// Tour-scoped, in-place content sync from the LOCAL DB to PROD, matched by natural key.
//
// Why this exists alongside sync-content.js (2026-10-13): sync-content.js delete+reinserts every
// site and every landmark-linked row on each run, which (a) silently wipes sites.audio_path (the
// CSVs don't carry it), (b) gives every POI a new id (open clients break until refresh), and (c)
// would now hit narration_listens.site_id -> sites(id) foreign keys once any team has earned a
// listen bonus on a POI. This script never deletes: it UPDATEs changed rows in place (keeping
// their ids) and INSERTs missing ones, copying every content column straight from the local DB —
// including audio_path. It also fixes diff-content.js's cross-tour false positives, since every
// landmark-linked key here is (tour, landmark sequence_order, ...), not bare sequence_order.
//
// Usage:
//   node scripts/db-sync/sync-by-key.js <tour_code>                 (read-only diff, local vs prod)
//   node scripts/db-sync/sync-by-key.js <tour_code> --apply         (writes to prod, one transaction)
//   ... --rename "Old site title=>New site title"                   (treat a prod site as renamed
//                                                                     rather than missing + extra)
// Rows only in prod ("extra") are reported, never deleted — review and remove by hand if needed.
const { localPool, prodPool } = require('./connections');

const tourCode = process.argv[2];
const apply = process.argv.includes('--apply');
const renames = new Map();
process.argv.forEach((arg, i) => {
  if (arg === '--rename') {
    const [from, to] = String(process.argv[i + 1] || '').split('=>');
    if (!from || !to) throw new Error('--rename expects "Old title=>New title"');
    renames.set(from.trim(), to.trim());
  }
});
if (!tourCode || tourCode.startsWith('--')) {
  console.error('Usage: node scripts/db-sync/sync-by-key.js <tour_code> [--apply] [--rename "Old=>New"]');
  process.exit(1);
}

// Each table: how to select its rows for one tour with a natural key, which columns are content,
// and how to resolve the parent id on the target when inserting.
const TABLES = [
  {
    name: 'landmarks',
    select: `SELECT l.*, l.sequence_order::text AS nk FROM landmarks l WHERE l.tour_id = $1`,
    fields: ['sequence_order', 'title', 'address', 'latitude', 'longitude', 'about_landmark_label', 'about_landmark_text',
      'about_subject_label', 'about_subject_text', 'interesting_fact', 'external_link', 'audio_path', 'quiz_format'],
    parent: { column: 'tour_id', resolve: 'tour' },
  },
  {
    name: 'landmark_images',
    select: `SELECT x.*, l.sequence_order || ':' || x.sort_order AS nk, l.sequence_order AS lseq
             FROM landmark_images x JOIN landmarks l ON l.id = x.landmark_id WHERE l.tour_id = $1`,
    fields: ['image_path', 'sort_order'],
    parent: { column: 'landmark_id', resolve: 'landmark' },
  },
  {
    name: 'clues',
    select: `SELECT x.*, l.sequence_order::text AS nk, l.sequence_order AS lseq
             FROM clues x JOIN landmarks l ON l.id = x.landmark_id WHERE l.tour_id = $1`,
    fields: ['type', 'clue_text'],
    parent: { column: 'landmark_id', resolve: 'landmark' },
  },
  {
    name: 'clue_hints',
    select: `SELECT x.*, l.sequence_order || ':' || x.hint_order AS nk, l.sequence_order AS lseq
             FROM clue_hints x JOIN clues c ON c.id = x.clue_id JOIN landmarks l ON l.id = c.landmark_id WHERE l.tour_id = $1`,
    fields: ['hint_order', 'hint_text'],
    parent: { column: 'clue_id', resolve: 'clue' },
  },
  {
    name: 'puzzles',
    select: `SELECT x.*, l.sequence_order::text AS nk, l.sequence_order AS lseq
             FROM puzzles x JOIN landmarks l ON l.id = x.landmark_id WHERE l.tour_id = $1`,
    fields: ['type', 'question_text', 'answer_payload', 'explanation'],
    parent: { column: 'landmark_id', resolve: 'landmark' },
  },
  {
    name: 'quiz_questions',
    select: `SELECT x.*, l.sequence_order || ':' || x.sequence_order AS nk, l.sequence_order AS lseq
             FROM quiz_questions x JOIN landmarks l ON l.id = x.landmark_id WHERE l.tour_id = $1`,
    fields: ['sequence_order', 'type', 'question_text', 'answer_payload', 'explanation', 'points'],
    parent: { column: 'landmark_id', resolve: 'landmark' },
  },
  {
    name: 'sites',
    select: `SELECT s.*, s.title AS nk FROM sites s WHERE s.tour_id = $1`,
    fields: ['title', 'address', 'type', 'latitude', 'longitude', 'about_site_label', 'about_site_text', 'about_subject_label',
      'about_subject_text', 'interesting_fact', 'image_path', 'audio_path', 'external_link'],
    parent: { column: 'tour_id', resolve: 'tour' },
  },
];

function stable(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
    return JSON.stringify(sort(value));
  }
  if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value))) return String(Number(value));
  return String(value);
}

function short(value) {
  const s = stable(value);
  if (s === null) return '(null)';
  return s.length > 90 ? s.slice(0, 87) + '...' : s;
}

async function main() {
  const local = localPool();
  const prod = prodPool();
  const tourId = async (pool) => (await pool.query('SELECT id FROM tours WHERE tour_code = $1', [tourCode])).rows[0]?.id;
  const localTour = await tourId(local);
  const prodTour = await tourId(prod);
  if (!localTour || !prodTour) throw new Error(`Tour '${tourCode}' missing on ${localTour ? 'prod' : 'local'}.`);

  const plan = [];
  let totalChanged = 0, totalMissing = 0, totalExtra = 0;
  for (const t of TABLES) {
    const lrows = (await local.query(t.select, [localTour])).rows;
    const prows = (await prod.query(t.select, [prodTour])).rows;
    if (t.name === 'sites') for (const r of prows) if (renames.has(r.nk)) r.nk = renames.get(r.nk);
    const pmap = new Map(prows.map((r) => [r.nk, r]));
    const lmap = new Map(lrows.map((r) => [r.nk, r]));
    const changed = [], missing = [], extra = [];
    for (const l of lrows) {
      const p = pmap.get(l.nk);
      if (!p) { missing.push(l); continue; }
      const diffs = t.fields.filter((f) => stable(l[f]) !== stable(p[f]));
      if (diffs.length) changed.push({ l, p, diffs });
    }
    for (const p of prows) if (!lmap.has(p.nk)) extra.push(p);
    totalChanged += changed.length; totalMissing += missing.length; totalExtra += extra.length;
    if (!changed.length && !missing.length && !extra.length) continue;
    console.log(`\n=== ${t.name}: ${changed.length} changed, ${missing.length} missing from prod, ${extra.length} only in prod ===`);
    for (const c of changed) {
      console.log(`  ~ [${c.l.nk}]`);
      for (const f of c.diffs) console.log(`      ${f}: prod=${short(c.p[f])}\n      ${' '.repeat(f.length)}  local=${short(c.l[f])}`);
    }
    for (const m of missing) console.log(`  + [${m.nk}]`);
    for (const e of extra) console.log(`  ! [${e.nk}] only in prod — NOT deleted`);
    plan.push({ t, changed, missing });
  }
  console.log(`\nTotals for ${tourCode}: ${totalChanged} changed, ${totalMissing} missing from prod, ${totalExtra} only in prod.`);

  if (!apply) {
    console.log(totalChanged || totalMissing ? 'Read-only run. Re-run with --apply to write these to prod.' : 'In sync.');
    await local.end(); await prod.end();
    return;
  }

  const client = await prod.connect();
  try {
    await client.query('BEGIN');
    // Parent ids are resolved on prod at insert time, in table order, so a landmark inserted
    // earlier in this same transaction is visible to its children.
    const resolveParent = async (kind, row) => {
      if (kind === 'tour') return prodTour;
      if (kind === 'landmark') {
        return (await client.query('SELECT id FROM landmarks WHERE tour_id = $1 AND sequence_order = $2', [prodTour, row.lseq])).rows[0]?.id;
      }
      return (await client.query(
        'SELECT c.id FROM clues c JOIN landmarks l ON l.id = c.landmark_id WHERE l.tour_id = $1 AND l.sequence_order = $2', [prodTour, row.lseq],
      )).rows[0]?.id;
    };
    const bind = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
    for (const { t, changed, missing } of plan) {
      for (const c of changed) {
        const sets = c.diffs.map((f, i) => `${f} = $${i + 1}`).join(', ');
        await client.query(`UPDATE ${t.name} SET ${sets} WHERE id = $${c.diffs.length + 1}`, [...c.diffs.map((f) => bind(c.l[f])), c.p.id]);
      }
      for (const m of missing) {
        const parentId = await resolveParent(t.parent.resolve, m);
        if (!parentId) throw new Error(`No prod parent for ${t.name} [${m.nk}]`);
        const cols = [t.parent.column, ...t.fields];
        const vals = [parentId, ...t.fields.map((f) => bind(m[f]))];
        await client.query(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
      }
    }
    await client.query('COMMIT');
    console.log('Applied to prod (committed).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rolled back — nothing written:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await local.end(); await prod.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
