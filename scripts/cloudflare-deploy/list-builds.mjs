// Lists the most recent Cloudflare Workers Builds for the live TOURZ app, so a git push can be
// confirmed as actually built + deployed (match commit hash against `git log`) instead of assumed.
// Read-only. Uses the same CLOUDFLARE_API_TOKEN in this directory's .env as toggle-dev-mode.mjs.
// Lists by worker tag - the per-trigger builds endpoint doesn't exist (see
// reference_cloudflare_builds_api memory).
// Usage: node list-builds.mjs [count]        (default 5)
//        node list-builds.mjs --wait <hash>  (poll until that commit's build stops, max 5 min)
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '.env'), 'utf8');
const TOKEN = envText.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN not found in scripts/cloudflare-deploy/.env');

const ACCOUNT_ID = '515a9a8eda5898f14074153c763220fb';
const WORKER_TAG = '1d673a1a70994503b7f040d5a8a2d60a';
const API = 'https://api.cloudflare.com/client/v4';

async function listBuilds(count) {
  const res = await fetch(`${API}/accounts/${ACCOUNT_ID}/builds/workers/${WORKER_TAG}/builds?per_page=${count}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`Cloudflare API error: ${JSON.stringify(body.errors)}`);
  return body.result;
}

function describe(b) {
  const m = b.build_trigger_metadata || {};
  return `${(m.commit_hash || '').slice(0, 7)}  status=${b.status} outcome=${b.build_outcome ?? '-'}  ${b.created_on}  ${(m.commit_message || '').split('\n')[0]}`;
}

const waitIdx = process.argv.indexOf('--wait');
if (waitIdx !== -1) {
  const hash = process.argv[waitIdx + 1];
  if (!hash) throw new Error('--wait expects a commit hash');
  const start = Date.now();
  while (Date.now() - start < 5 * 60 * 1000) {
    const build = (await listBuilds(10)).find((b) => (b.build_trigger_metadata?.commit_hash || '').startsWith(hash));
    if (build) {
      console.log(describe(build));
      if (build.status === 'stopped') { process.exitCode = build.build_outcome === 'success' ? 0 : 1; break; }
    } else {
      console.log(`no build yet for ${hash}`);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  if (process.exitCode === undefined) { console.log('timed out waiting'); process.exitCode = 1; }
} else {
  for (const b of await listBuilds(Number(process.argv[2]) || 5)) console.log(describe(b));
}
