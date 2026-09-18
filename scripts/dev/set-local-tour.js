// Repoints the local DEV-LOCAL game code at a different tour, so the app's dev-mode auto-login
// (POST /api/dev/login in server/index.js) lands on that tour on the next local load.
// Usage: node scripts/dev/set-local-tour.js <tourCode>   e.g. edinburgh | port-louis
//
// Switching tours clears any existing DEV-LOCAL game/team/players first — a team's progress
// (current_landmark_sequence, progress_events) is only meaningful against the tour it was
// created under, so it can't just carry over to a different tour's landmarks.
const { Client } = require('pg');

async function main() {
  const tourCode = process.argv[2];
  if (!tourCode) {
    console.error('Usage: node scripts/dev/set-local-tour.js <tourCode>');
    process.exit(1);
  }

  const client = new Client({ host: 'localhost', port: 5432, user: 'postgres', database: 'tourz' });
  await client.connect();

  try {
    const { rows: [tour] } = await client.query('SELECT id, name FROM tours WHERE tour_code = $1', [tourCode]);
    if (!tour) {
      const { rows: available } = await client.query('SELECT tour_code FROM tours ORDER BY tour_code');
      console.error(`No tour found with tour_code '${tourCode}'. Available: ${available.map(r => r.tour_code).join(', ')}`);
      process.exit(1);
    }

    const { rows: [gameCode] } = await client.query(`SELECT id, tour_id FROM game_codes WHERE code = 'DEV-LOCAL'`);

    if (!gameCode) {
      await client.query(
        `INSERT INTO game_codes (code, tour_id, expires_at) VALUES ('DEV-LOCAL', $1, now() + interval '10 years')`,
        [tour.id]
      );
      console.log(`Created DEV-LOCAL pointing at '${tourCode}' (${tour.name}).`);
      return;
    }

    if (gameCode.tour_id === tour.id) {
      console.log(`DEV-LOCAL already points at '${tourCode}' (${tour.name}) — nothing to do.`);
      return;
    }

    await client.query('BEGIN');
    await client.query(`
      DELETE FROM location_pings WHERE player_id IN (
        SELECT p.id FROM players p JOIN teams t ON p.team_id = t.id
        JOIN games g ON t.game_id = g.id WHERE g.game_code_id = $1
      )`, [gameCode.id]);
    await client.query(`
      DELETE FROM messages WHERE team_id IN (
        SELECT t.id FROM teams t JOIN games g ON t.game_id = g.id WHERE g.game_code_id = $1
      )`, [gameCode.id]);
    await client.query(`
      DELETE FROM progress_events WHERE team_id IN (
        SELECT t.id FROM teams t JOIN games g ON t.game_id = g.id WHERE g.game_code_id = $1
      )`, [gameCode.id]);
    await client.query(`
      DELETE FROM players WHERE team_id IN (
        SELECT t.id FROM teams t JOIN games g ON t.game_id = g.id WHERE g.game_code_id = $1
      )`, [gameCode.id]);
    await client.query(`DELETE FROM teams WHERE game_id IN (SELECT id FROM games WHERE game_code_id = $1)`, [gameCode.id]);
    await client.query(`DELETE FROM games WHERE game_code_id = $1`, [gameCode.id]);
    await client.query(`UPDATE game_codes SET tour_id = $1, status = 'unused' WHERE id = $2`, [tour.id, gameCode.id]);
    await client.query('COMMIT');

    console.log(`Switched DEV-LOCAL to '${tourCode}' (${tour.name}). Previous dev team/game data cleared.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
