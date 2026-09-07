// Creates a new game_codes row directly against the live Render production database.
// Usage: node create-game-code.js <CODE> <maxPlayers>
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
  const [code, maxPlayersArg] = process.argv.slice(2);
  const maxPlayers = Number(maxPlayersArg);
  if (!code || !Number.isInteger(maxPlayers) || maxPlayers < 1) {
    console.error('Usage: node create-game-code.js <CODE> <maxPlayers>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const { rows: tours } = await pool.query('SELECT id, name FROM tours ORDER BY id');
  if (tours.length !== 1) {
    console.error('Expected exactly one tour, found:', tours);
    process.exit(1);
  }
  const tourId = tours[0].id;

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
