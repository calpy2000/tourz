// Generates narration MP3s for every Port Louis landmark and site using the voice/tier decided
// in google-tts-test.js (Chirp3-HD, en-GB-Chirp3-HD-Kore). Output goes to server/content-audio/,
// mirroring how server/content-photos/ holds image files, served the same way once a static
// route + audio_path column exist (not added yet — this script only produces the files).
const fs = require('fs');
const path = require('path');
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
    `SELECT id, sequence_order, title, about_landmark_text, about_subject_text, interesting_fact
     FROM landmarks WHERE tour_id = $1 ORDER BY sequence_order`,
    [TOUR_ID]
  );
  const sites = await client.query(
    `SELECT id, title, about_site_text, interesting_fact
     FROM sites WHERE tour_id = $1 ORDER BY id`,
    [TOUR_ID]
  );
  client.release();
  await pool.end();

  const items = [];
  for (const l of landmarks.rows) {
    const text = [l.about_landmark_text, l.about_subject_text, l.interesting_fact].filter(Boolean).join(' ');
    items.push({ filename: `port-louis-landmark-${l.id}.mp3`, title: l.title, text });
  }
  for (const s of sites.rows) {
    const text = [s.about_site_text, s.interesting_fact].filter(Boolean).join(' ');
    items.push({ filename: `port-louis-site-${s.id}.mp3`, title: s.title, text });
  }

  console.log(`${items.length} items to narrate (${landmarks.rows.length} landmarks, ${sites.rows.length} sites)`);

  let done = 0, skipped = 0, failed = 0, totalChars = 0;
  const failures = [];

  for (const item of items) {
    const outPath = path.join(OUT_DIR, item.filename);
    if (fs.existsSync(outPath)) {
      skipped++;
      continue;
    }
    if (!item.text.trim()) {
      console.warn(`SKIP (no text): ${item.filename} — ${item.title}`);
      skipped++;
      continue;
    }
    try {
      const audio = await synthesize(item.text);
      fs.writeFileSync(outPath, audio);
      totalChars += item.text.length;
      done++;
      console.log(`[${done + skipped + failed}/${items.length}] wrote ${item.filename} — ${item.title} (${item.text.length} chars)`);
    } catch (err) {
      failed++;
      failures.push({ filename: item.filename, title: item.title, error: err.message });
      console.error(`FAILED: ${item.filename} — ${item.title}: ${err.message}`);
    }
    await sleep(150);
  }

  console.log('\n--- Summary ---');
  console.log(`Generated: ${done}`);
  console.log(`Skipped (already existed / no text): ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Characters synthesized this run: ${totalChars}`);
  if (failures.length) {
    console.log('Failures:', failures);
    process.exitCode = 1;
  }
})();
