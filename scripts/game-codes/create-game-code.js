// Creates a new game_codes row directly against the live Render production database.
// Usage: node create-game-code.js <CODE> <maxPlayers> [tourCode]
// tourCode defaults to 'edinburgh' (the only tour live in production so far) — pass it
// explicitly once a second tour (e.g. 'port-louis') is deployed to prod.
//
// Requires PROD_DATABASE_URL in this directory's own .env (gitignored, see
// reference_render_production_db memory for where that connection string comes from).
const { readFileSync } = require('fs');
const { join } = require('path');
const { Pool } = require('pg');

const envText = readFileSync(join(__dirname, '.env'), 'utf8');
const DATABASE_URL = envText.match(/^PROD_DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!DATABASE_URL) throw new Error('PROD_DATABASE_URL not found in scripts/game-codes/.env');

async function main() {
  const [code, maxPlayersArg, tourCodeArg] = process.argv.slice(2);
  const maxPlayers = Number(maxPlayersArg);
  const tourCode = tourCodeArg || 'edinburgh';
  if (!code || !Number.isInteger(maxPlayers) || maxPlayers < 1) {
    console.error('Usage: node create-game-code.js <CODE> <maxPlayers> [tourCode]');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const { rows: [tour] } = await pool.query('SELECT id, name FROM tours WHERE tour_code = $1', [tourCode]);
  if (!tour) {
    console.error(`No tour found with tour_code '${tourCode}'.`);
    process.exit(1);
  }
  const tourId = tour.id;

  const { rows } = await pool.query(
    `INSERT INTO game_codes (code, tour_id, max_players, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')
     RETURNING *`,
    [code, tourId, maxPlayers]
  );
  console.log('Inserted game code:', rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
