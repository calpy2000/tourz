// Deletes LIVE GAME DATA (games/teams/players/progress/messages/location pings) from the prod
// database for one or more game codes — or every game code if none are given. The game_codes
// row itself is never deleted; its status is reset to 'unused' so the code stays reusable (see
// reference_render_production_db / project_registration_feature memory: codes are reusable).
//
// Usage:
//   node delete-game-data.js                 delete game data for EVERY game code
//   node delete-game-data.js TEST T1         delete game data only for these codes
//
// Requires PROD_DATABASE_URL in this directory's own .env (gitignored, see
// reference_render_production_db memory for where that connection string comes from).
const { readFileSync } = require('fs');
const { join } = require('path');
const { Pool } = require('pg');

const envText = readFileSync(join(__dirname, '.env'), 'utf8');
const DATABASE_URL = envText.match(/^PROD_DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!DATABASE_URL) throw new Error('PROD_DATABASE_URL not found in scripts/game-codes/.env');

async function deleteGameDataForCode(client, gameCode) {
  const { rows: [game] } = await client.query('SELECT * FROM games WHERE game_code_id = $1', [gameCode.id]);
  if (!game) {
    console.log(`  ${gameCode.code}: no live game yet, nothing to delete`);
    return;
  }

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
  } else {
    console.log(`  ${gameCode.code}: game existed with no team`);
  }

  await client.query('DELETE FROM games WHERE id = $1', [game.id]);
  await client.query(`UPDATE game_codes SET status = 'unused' WHERE id = $1`, [gameCode.id]);
}

async function main() {
  const codesArg = process.argv.slice(2);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    let gameCodes;
    if (codesArg.length === 0) {
      ({ rows: gameCodes } = await client.query('SELECT * FROM game_codes ORDER BY id'));
      console.log(`No codes given — deleting live game data for ALL ${gameCodes.length} game codes.`);
    } else {
      ({ rows: gameCodes } = await client.query('SELECT * FROM game_codes WHERE code = ANY($1) ORDER BY id', [codesArg]));
      const found = new Set(gameCodes.map((g) => g.code));
      const missing = codesArg.filter((c) => !found.has(c));
      if (missing.length > 0) console.warn(`Warning: unknown game codes, skipping: ${missing.join(', ')}`);
      console.log(`Deleting live game data for: ${gameCodes.map((g) => g.code).join(', ')}`);
    }

    await client.query('BEGIN');
    for (const gameCode of gameCodes) {
      await deleteGameDataForCode(client, gameCode);
    }
    await client.query('COMMIT');
    console.log('Done. Game codes remain in game_codes (status reset to unused where a game existed).');
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
