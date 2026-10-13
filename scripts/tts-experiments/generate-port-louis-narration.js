// Generates narration MP3s for every Port Louis landmark and site using the voice/tier decided
// in google-tts-test.js (Chirp3-HD, en-GB-Chirp3-HD-Kore). Output goes to server/content-audio/.
//
// HARD RULE: run this after ANY change to a site's or landmark's narrated text (about_*_text,
// interesting_fact) - it regenerates exactly the MP3s whose text changed, and nothing else.
// narration-manifest.json records a hash of the text each MP3 was made from; an existing MP3
// whose hash no longer matches the current DB text is stale and gets regenerated (the old file
// is kept in output/replaced/). It also sets audio_path for any row that's missing it.
//
//   node scripts/tts-experiments/generate-port-louis-narration.js            regenerate stale/missing
//   node scripts/tts-experiments/generate-port-louis-narration.js --check    report only, exit 1 if any
//   node scripts/tts-experiments/generate-port-louis-narration.js --baseline record current text as
//        matching every existing MP3 (only after confirming they really are in sync)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { localPool } = require('../db-sync/connections.js');

function readApiKey() {
  const envPath = path.join(__dirname, '.env');
  const envText = fs.readFileSync(envPath, 'utf8');
  const key = envText.match(/^GOOGLE_TTS_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error('GOOGLE_TTS_API_KEY not found in scripts/tts-experiments/.env');
  return key;
}

const API_KEY = readApiKey();
const VOICE_NAME = 'en-GB-Chirp3-HD-Kore';
const LANGUAGE_CODE = 'en-GB';
const TOUR_ID = 17; // Port Louis Heritage Walk
const OUT_DIR = path.join(__dirname, '..', '..', 'server', 'content-audio');
const MANIFEST_PATH = path.join(__dirname, 'narration-manifest.json');
const REPLACED_DIR = path.join(__dirname, 'output', 'replaced');
const CHECK = process.argv.includes('--check');
const BASELINE = process.argv.includes('--baseline');

const hashText = (text) => crypto.createHash('sha256').update(text).digest('hex');

function loadManifest() {
  return fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : {};
}

function saveManifest(manifest) {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesize(text) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return Buffer.from(data.audioContent, 'base64');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pool = localPool();
  const client = await pool.connect();

  const landmarks = await client.query(
    `SELECT id, sequence_order, title, about_landmark_text, about_subject_text, interesting_fact, audio_path
     FROM landmarks WHERE tour_id = $1 ORDER BY sequence_order`,
    [TOUR_ID]
  );
  const sites = await client.query(
    `SELECT id, title, about_site_text, interesting_fact, audio_path
     FROM sites WHERE tour_id = $1 ORDER BY id`,
    [TOUR_ID]
  );

  const items = [];
  for (const l of landmarks.rows) {
    const text = [l.about_landmark_text, l.about_subject_text, l.interesting_fact].filter(Boolean).join(' ');
    items.push({ table: 'landmarks', id: l.id, audioPath: l.audio_path, filename: `port-louis-landmark-${l.id}.mp3`, title: l.title, text });
  }
  for (const s of sites.rows) {
    const text = [s.about_site_text, s.interesting_fact].filter(Boolean).join(' ');
    items.push({ table: 'sites', id: s.id, audioPath: s.audio_path, filename: `port-louis-site-${s.id}.mp3`, title: s.title, text });
  }

  const manifest = loadManifest();

  if (BASELINE) {
    let recorded = 0;
    for (const item of items) {
      if (item.text.trim() && fs.existsSync(path.join(OUT_DIR, item.filename))) {
        manifest[item.filename] = hashText(item.text);
        recorded++;
      }
    }
    saveManifest(manifest);
    console.log(`Baseline recorded for ${recorded} existing MP3s in ${path.basename(MANIFEST_PATH)}`);
    client.release();
    await pool.end();
    return;
  }

  // Classify every item before touching anything, so --check and a real run agree exactly.
  const work = [];
  for (const item of items) {
    if (!item.text.trim()) continue;
    const exists = fs.existsSync(path.join(OUT_DIR, item.filename));
    const reason = !exists ? 'missing'
      : manifest[item.filename] !== hashText(item.text) ? 'stale (text changed)'
      : null;
    const needsAudioPath = item.audioPath !== item.filename;
    if (reason || needsAudioPath) work.push({ ...item, reason, needsAudioPath });
  }

  console.log(`${items.length} items (${landmarks.rows.length} landmarks, ${sites.rows.length} sites); ${work.length} need attention`);
  for (const w of work) {
    console.log(`  ${w.table} ${w.id} ${w.title}: ${[w.reason, w.needsAudioPath && `audio_path is ${w.audioPath}`].filter(Boolean).join(', ')}`);
  }

  if (CHECK) {
    client.release();
    await pool.end();
    if (work.length) process.exitCode = 1;
    return;
  }

  let done = 0, failed = 0, totalChars = 0;
  const failures = [];

  for (const item of work) {
    const outPath = path.join(OUT_DIR, item.filename);
    try {
      if (item.reason) {
        const audio = await synthesize(item.text);
        if (fs.existsSync(outPath)) {
          fs.mkdirSync(REPLACED_DIR, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.renameSync(outPath, path.join(REPLACED_DIR, item.filename.replace(/\.mp3$/, `.${stamp}.mp3`)));
        }
        fs.writeFileSync(outPath, audio);
        manifest[item.filename] = hashText(item.text);
        saveManifest(manifest);
        totalChars += item.text.length;
        done++;
        console.log(`wrote ${item.filename} — ${item.title} (${item.text.length} chars, was ${item.reason})`);
        await sleep(150);
      }
      if (item.needsAudioPath) {
        await client.query(`UPDATE ${item.table} SET audio_path = $1 WHERE id = $2`, [item.filename, item.id]);
        console.log(`set ${item.table} ${item.id} audio_path = ${item.filename}`);
      }
    } catch (err) {
      failed++;
      failures.push({ filename: item.filename, title: item.title, error: err.message });
      console.error(`FAILED: ${item.filename} — ${item.title}: ${err.message}`);
    }
  }

  client.release();
  await pool.end();

  console.log('\n--- Summary ---');
  console.log(`Generated: ${done}`);
  console.log(`Failed: ${failed}`);
  console.log(`Characters synthesized this run: ${totalChars}`);
  if (failures.length) {
    console.log('Failures:', failures);
    process.exitCode = 1;
  }
})();
