// Permanently deletes game_codes rows (and all dependent live game data) from the prod
// database. Unlike delete-game-data.js, the game_codes row itself IS removed — the code stops
// existing and is no longer reusable. Use this to retire test/one-off codes; use
// delete-game-data.js instead when you just want to reset a code back to 'unused' and keep it.
//
// Usage:
//   node delete-game-codes.js <CODE> [CODE...]   delete these game codes entirely
//
// Requires PROD_DATABASE_URL in this directory's own .env (gitignored, see
// reference_render_production_db memory for where that connection string comes from).
const { readFileSync } = require('fs');
const { join } = require('path');
const { Pool } = require('pg');

const envText = readFileSync(join(__dirname, '.env'), 'utf8');
const DATABASE_URL = envText.match(/^PROD_DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!DATABASE_URL) throw new Error('PROD_DATABASE_URL not found in scripts/game-codes/.env');

async function deleteGameCode(client, gameCode) {
  const { rows: [game] } = await client.query('SELECT * FROM games WHERE game_code_id = $1', [gameCode.id]);
  if (game) {
    const { rows: [team] } = await client.query('SELECT * FROM teams WHERE game_id = $1', [game.id]);
    if (team) {
      const { rowCount: pings } = await client.query(
        'DELETE FROM location_pings WHERE player_id IN (SELECT id FROM players WHERE team_id = $1)',
        [team.id]
      );
      const { rowCount: events } = await client.query('DELETE FROM progress_events WHERE team_id = $1', [team.id]);
      const { rowCount: msgs } = await client.query('DELETE FROM messages WHERE team_id = $1', [team.id]);
      const { rowCount: players } = await client.query('DELETE FROM players WHERE team_id = $1', [team.id]);
      await client.query('DELETE FROM teams WHERE id = $1', [team.id]);
      console.log(`  ${gameCode.code}: deleted 1 team, ${players} players, ${events} progress events, ${msgs} messages, ${pings} location pings`);
    }
    await client.query('DELETE FROM games WHERE id = $1', [game.id]);
  }

  await client.query('DELETE FROM game_codes WHERE id = $1', [gameCode.id]);
  console.log(`  ${gameCode.code}: game code deleted`);
}

async function main() {
  const codesArg = process.argv.slice(2);
  if (codesArg.length === 0) {
    console.error('Usage: node delete-game-codes.js <CODE> [CODE...]');
    console.error('Refuses to run with no codes — this permanently deletes game codes, unlike delete-game-data.js.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    const { rows: gameCodes } = await client.query('SELECT * FROM game_codes WHERE code = ANY($1) ORDER BY id', [codesArg]);
    const found = new Set(gameCodes.map((g) => g.code));
    const missing = codesArg.filter((c) => !found.has(c));
    if (missing.length > 0) console.warn(`Warning: unknown game codes, skipping: ${missing.join(', ')}`);
    console.log(`Permanently deleting game codes: ${gameCodes.map((g) => g.code).join(', ')}`);

    await client.query('BEGIN');
    for (const gameCode of gameCodes) {
      await deleteGameCode(client, gameCode);
    }
    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
