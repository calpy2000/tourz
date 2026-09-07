// Shared local/prod Postgres connections for the db-sync scripts.
// Prod connection string lives in scripts/game-codes/.env (gitignored) — see
// reference_render_production_db memory for where that value comes from.
const { readFileSync } = require('fs');
const { join } = require('path');
const { Pool } = require('pg');

function prodDatabaseUrl() {
  const envPath = join(__dirname, '..', 'game-codes', '.env');
  const envText = readFileSync(envPath, 'utf8');
  const url = envText.match(/^PROD_DATABASE_URL=(.+)$/m)?.[1]?.trim();
  if (!url) throw new Error('PROD_DATABASE_URL not found in scripts/game-codes/.env');
  return url;
}

function localPool() {
  return new Pool({ host: 'localhost', user: 'postgres', database: 'tourz' });
}

function prodPool() {
  return new Pool({ connectionString: prodDatabaseUrl(), ssl: { rejectUnauthorized: false } });
}

module.exports = { localPool, prodPool };
