// Applies one db/migrations/*.sql file to the local DB, or to prod with --prod — without a
// credential ever appearing on the command line (connections.js reads it). The file runs as one
// transaction; migrations here are written to be safe to re-run (IF NOT EXISTS etc.).
//
//   node scripts/db-sync/apply-migration.js db/migrations/2026-10-18-offline-sync.sql [--prod]
//
// Prints the tables the migration mentions afterwards, so the result is visible.

const fs = require('fs');
const path = require('path');
const { localPool, prodPool } = require('./connections');

async function main() {
  const file = process.argv[2];
  const prod = process.argv.includes('--prod');
  if (!file || !file.endsWith('.sql')) {
    console.error('Usage: node scripts/db-sync/apply-migration.js <migration.sql> [--prod]');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  const pool = prod ? prodPool() : localPool();
  const client = await pool.connect();
  try {
    console.log(`Applying ${path.basename(file)} to ${prod ? 'PROD' : 'local'}...`);
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    const tables = [...new Set([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)].map((m) => m[1]))];
    for (const t of tables) {
      const { rows } = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [t]
      );
      console.log(`  ${t}: ${rows.map((r) => r.column_name).join(', ')}`);
    }
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
