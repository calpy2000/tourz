// Read-only pre-push helper: prod instance-table snapshot, Port Louis game codes, Cloudflare
// VITE_DEV_MODE build var. Writes only a local JSON file under backups/instance-snapshots/.
const fs = require('fs');
const path = require('path');
const { prodPool } = require('./connections');

(async () => {
  const p = prodPool();
  const tables = ['game_codes', 'games', 'teams', 'players', 'progress_events', 'narration_listens', 'location_pings', 'client_actions'];
  const snap = {};
  for (const t of tables) snap[t] = (await p.query(`SELECT * FROM ${t}`)).rows;
  const dir = path.join(__dirname, '..', '..', 'backups', 'instance-snapshots', 'prod-instance-pre-pl-gps-20261020');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(snap, null, 1));
  console.log('Instance snapshot:', file);
  console.log('Counts:', Object.fromEntries(tables.map(t => [t, snap[t].length])));

  const codes = await p.query(`
    SELECT gc.code, gc.status, gc.expires_at, gc.max_players, t.tour_code
      FROM game_codes gc JOIN tours t ON t.id = gc.tour_id
     ORDER BY t.tour_code, gc.code`).catch(async () => p.query(`
    SELECT gc.*, t.tour_code FROM game_codes gc JOIN tours t ON t.id = gc.tour_id ORDER BY t.tour_code, gc.code`));
  console.log('\nGame codes:');
  for (const r of codes.rows) {
    console.log(` ${r.tour_code.padEnd(11)} ${String(r.code).padEnd(10)} ${r.status.padEnd(9)} expires ${new Date(r.expires_at).toISOString().slice(0, 10)}${r.max_players != null ? ' max_players=' + r.max_players : ''}`);
  }
  await p.end();

  const env = fs.readFileSync(path.join(__dirname, '..', 'cloudflare-deploy', '.env'), 'utf8');
  const token = env.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)[1].trim();
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts/515a9a8eda5898f14074153c763220fb/builds/triggers/ca78f1c0-4081-4b34-8bb5-0f085463b765/environment_variables', { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  console.log('\nCloudflare VITE_DEV_MODE:', j.result?.VITE_DEV_MODE?.value ?? JSON.stringify(j.errors));
})().catch(e => { console.error(e); process.exit(1); });
