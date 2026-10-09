// Checks that every file path referenced by local content — image_path (sites, landmark_images)
// and audio_path (landmarks, sites) — actually resolves (HTTP 200) on the live prod backend's
// static routes (/content-photos, /content-audio respectively). Catches the case where a file was
// added/changed locally and committed, but the prod Render deploy is stale or the file never made
// it into the commit that's actually live — a gap the DB-content diff (diff-content.js) can't see,
// since it only compares the path string, not the file behind it.
//
// Read-only against prod (HTTP GET only, no DB writes). Run with:
//   node scripts/db-sync/check-images.js
const { localPool } = require('./connections');

const PROD_API_BASE = 'https://tourz-api.onrender.com';
const CONCURRENCY = 10;

async function checkPaths(label, paths, urlSegment) {
  console.log(`Checking ${paths.length} distinct ${label} path(s) against ${PROD_API_BASE}/${urlSegment}/ ...`);

  const missing = [];
  let cursor = 0;

  async function worker() {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      const url = `${PROD_API_BASE}/${urlSegment}/${encodeURIComponent(path)}`;
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
    console.log(`All ${label} files resolve 200 on prod.`);
    return missing;
  }

  console.log(`\n=== ${missing.length} ${label} path(s) NOT resolving on prod ===`);
  for (const m of missing) console.log(`  ${m.path} -> ${m.status}`);
  return missing;
}

async function main() {
  const pool = localPool();
  let imagePaths;
  let audioPaths;
  try {
    const { rows: siteImageRows } = await pool.query(
      `SELECT DISTINCT image_path FROM sites WHERE image_path IS NOT NULL`
    );
    const { rows: landmarkImageRows } = await pool.query(
      `SELECT DISTINCT image_path FROM landmark_images WHERE image_path IS NOT NULL`
    );
    imagePaths = [...new Set([...siteImageRows, ...landmarkImageRows].map((r) => r.image_path))].sort();

    const { rows: landmarkAudioRows } = await pool.query(
      `SELECT DISTINCT audio_path FROM landmarks WHERE audio_path IS NOT NULL`
    );
    const { rows: siteAudioRows } = await pool.query(
      `SELECT DISTINCT audio_path FROM sites WHERE audio_path IS NOT NULL`
    );
    audioPaths = [...new Set([...landmarkAudioRows, ...siteAudioRows].map((r) => r.audio_path))].sort();
  } finally {
    await pool.end();
  }

  const missingImages = await checkPaths('image', imagePaths, 'content-photos');
  console.log('');
  const missingAudio = await checkPaths('audio', audioPaths, 'content-audio');

  if (missingImages.length === 0 && missingAudio.length === 0) {
    console.log('\nAll image and audio files resolve 200 on prod.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
