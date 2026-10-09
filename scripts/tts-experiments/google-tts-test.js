const fs = require('fs');
const path = require('path');

function readApiKey() {
  const envPath = path.join(__dirname, '.env');
  const envText = fs.readFileSync(envPath, 'utf8');
  const key = envText.match(/^GOOGLE_TTS_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error('GOOGLE_TTS_API_KEY not found in scripts/tts-experiments/.env');
  return key;
}

const API_KEY = readApiKey();

// One female voice per quality tier, for comparison.
const VOICE_NAMES = ['en-GB-Neural2-A', 'en-GB-Studio-C', 'en-GB-Chirp3-HD-Kore'];
const LANGUAGE_CODE = 'en-GB';

const samples = [
  {
    slug: 'jummah-masjid',
    aboutSite: `Step onto Royal Road in the heart of the old commercial quarter and Port Louis's principal mosque rises in front of you, known simply as Jummah Masjid. The city's mercantile community bought this plot on Queen Street in 1852 and consecrated the mosque a year later, when it went by a different name entirely - the "Mosque of the Arabs." What you're looking at today is largely a late-Victorian rebuild: a major expansion begun in 1878 under Jackaria Jan Mahomed dragged on for years, slowed by disease and building-supply shortages, and wasn't finished until 1895.`,
    interestingFact: `The mosque blends Indian, Creole and Islamic architectural styles so seamlessly that it's often named one of the most beautiful religious buildings in Mauritius.`,
  },
  {
    slug: 'government-house',
    aboutSite: `At the top of Place d'Armes stands the seat of Mauritius's government, colonial and now national both. France's claim to the island came decades before any of this was built: in September 1715, French captain Guillaume Dufresne d'Arsel landed on the then-abandoned Dutch colony, took possession of it for Louis XIV, and renamed it Isle de France - the name it carried for the next century. The first Government House here was built of wood in 1725 under the French - and lasted only two years before a cyclone tore it down in 1727. What replaced it was built to last: French governors Nicolas de Maupin and Mahé de La Bourdonnais enlarged it into the footprint you see today by 1738, when it was still known by its original name, the Hôtel du Gouvernement.`,
    interestingFact: `Place d'Armes, the grand palm-lined boulevard leading up to it, is often called the most iconic street in Mauritius, lined the whole way with statues of the figures who shaped the island's history.`,
  },
].map((s) => ({ slug: s.slug, text: `${s.aboutSite} ${s.interestingFact}` }));

async function synthesize(text, slug, voiceName) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: LANGUAGE_CODE, name: voiceName },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google TTS error for ${slug} (${voiceName}): ${JSON.stringify(data)}`);
  }

  const outPath = path.join(__dirname, 'output', `${slug}__${voiceName}.mp3`);
  fs.writeFileSync(outPath, Buffer.from(data.audioContent, 'base64'));
  console.log(`Wrote ${outPath}`);
}

(async () => {
  for (const voiceName of VOICE_NAMES) {
    for (const { slug, text } of samples) {
      await synthesize(text, slug, voiceName);
    }
  }
})();
