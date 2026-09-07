// Checks that every image_path referenced by local content (sites.image_path,
// landmark_images.image_path) actually resolves (HTTP 200) on the live prod backend's
// /content-photos static route. Catches the case where a photo was added/changed locally
// and committed, but the prod Render deploy is stale or the file never made it into the
// commit that's actually live — a gap the DB-content diff (diff-content.js) can't see,
// since it only compares the image_path string, not the file behind it.
//
// Read-only against prod (HTTP GET only, no DB writes). Run with:
//   node scripts/db-sync/check-images.js
const { localPool } = require('./connections');

const PROD_API_BASE = 'https://tourz-api.onrender.com';

async function main() {
  const pool = localPool();
  let paths;
  try {
    const { rows: siteRows } = await pool.query(
      `SELECT DISTINCT image_path FROM sites WHERE image_path IS NOT NULL`
    );
    const { rows: landmarkImageRows } = await pool.query(
      `SELECT DISTINCT image_path FROM landmark_images WHERE image_path IS NOT NULL`
    );
    paths = [...new Set([...siteRows, ...landmarkImageRows].map((r) => r.image_path))].sort();
  } finally {
    await pool.end();
  }

  console.log(`Checking ${paths.length} distinct image paths against ${PROD_API_BASE} ...`);

  const missing = [];
  const CONCURRENCY = 10;
  let cursor = 0;

  async function worker() {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      const url = `${PROD_API_BASE}/content-photos/${encodeURIComponent(path)}`;
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.status !== 200) missing.push({ path, status: res.status });
      } catch (err) {
        missing.push({ path, status: `error: ${err.message}` });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (missing.length === 0) {
    console.log('All image files resolve 200 on prod.');
    return;
  }

  console.log(`\n=== ${missing.length} image path(s) NOT resolving on prod ===`);
  for (const m of missing) console.log(`  ${m.path} -> ${m.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
