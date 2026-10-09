// One-off migration: drop the `messages` table from the PROD database, as part of the chat
// feature removal (see memory project_chat_feature_archive — removal was already done locally
// on 2026-10-08; this is the deferred prod half of that same change).
//
// Backs up every existing prod `messages` row to backups/db-snapshots/ as JSON before dropping,
// since backup-db.js deliberately never touches instance tables (messages included) and this is
// the only copy of that data that will ever exist once the table is gone.
//
// Usage: node scripts/db-sync/remove-messages-table-prod.js
const fs = require('fs');
const path = require('path');
const { prodPool } = require('./connections');

async function main() {
  const pool = prodPool();
  try {
    const { rows } = await pool.query('SELECT * FROM messages ORDER BY id');
    const dir = path.join(__dirname, '..', '..', 'backups', 'db-snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `prod-messages-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`Backed up ${rows.length} messages row(s) to ${file}`);

    await pool.query('DROP TABLE IF EXISTS messages');
    console.log('Dropped messages table on prod.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
