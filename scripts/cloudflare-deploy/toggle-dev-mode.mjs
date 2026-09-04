// Flips VITE_DEV_MODE on the live TOURZ app without any Cloudflare dashboard clicking, using the
// Workers Builds REST API (see reference_cloudflare_builds_api memory for how this was found).
// Usage: node toggle-dev-mode.mjs on|off
//
// Requires CLOUDFLARE_API_TOKEN in this directory's own .env (gitignored, kept separate from
// server/.env — this token can edit deploy config, which the app's own runtime has no business
// holding). The account id, worker tag and production trigger uuid are stable for this project,
// so they're hardcoded rather than re-discovered on every run.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '.env'), 'utf8');
const TOKEN = envText.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN not found in scripts/cloudflare-deploy/.env');

const ACCOUNT_ID = '515a9a8eda5898f14074153c763220fb';
const PROD_TRIGGER_UUID = 'ca78f1c0-4081-4b34-8bb5-0f085463b765'; // the "main" branch trigger

const API = 'https://api.cloudflare.com/client/v4';

async function cf(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`Cloudflare API error on ${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

async function setDevMode(on) {
  await cf(`/accounts/${ACCOUNT_ID}/builds/triggers/${PROD_TRIGGER_UUID}/environment_variables`, {
    method: 'PATCH',
    body: JSON.stringify({ VITE_DEV_MODE: { value: on ? 'true' : 'false', is_secret: false } }),
  });
  console.log(`VITE_DEV_MODE set to ${on}`);
}

async function triggerBuild() {
  const build = await cf(`/accounts/${ACCOUNT_ID}/builds/triggers/${PROD_TRIGGER_UUID}/builds`, {
    method: 'POST',
    body: JSON.stringify({ branch: 'main' }),
  });
  console.log(`Build triggered: ${build.build_uuid}`);
  return build.build_uuid;
}

async function waitForBuild(buildUuid, { timeoutMs = 5 * 60 * 1000, pollMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const build = await cf(`/accounts/${ACCOUNT_ID}/builds/builds/${buildUuid}`);
    console.log(`  status=${build.status} outcome=${build.build_outcome ?? '-'}`);
    if (build.status === 'stopped') return build;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('Timed out waiting for build to finish');
}

async function main() {
  const arg = process.argv[2];
  if (!['on', 'off'].includes(arg)) {
    console.error('Usage: node toggle-dev-mode.mjs on|off');
    process.exit(1);
  }
  const on = arg === 'on';

  await setDevMode(on);
  const buildUuid = await triggerBuild();
  const finished = await waitForBuild(buildUuid);

  if (finished.build_outcome !== 'success') {
    console.error(`Build finished with outcome "${finished.build_outcome}" — dev mode may not have taken effect.`);
    process.exit(1);
  }
  console.log(`Done. Live app dev-mode is now ${on ? 'ON' : 'OFF'}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
