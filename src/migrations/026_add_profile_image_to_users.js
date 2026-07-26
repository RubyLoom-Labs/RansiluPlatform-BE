const { getPool } = require('../config/db');

async function up(passedPool) {
  const pool = passedPool || getPool();

  console.log('Running migration 026: Add profile_image to users table...');

  const [columns] = await pool.query(`SHOW COLUMNS FROM users`);
  const columnNames = columns.map(c => c.Field);

  if (!columnNames.includes('profile_image')) {
    await pool.query(`ALTER TABLE users ADD COLUMN profile_image VARCHAR(500) NULL AFTER email`);
  }

  console.log('Migration 026 completed successfully.');
}

async function down(passedPool) {
  const pool = passedPool || getPool();
  await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS profile_image`);
}

module.exports = { up, down };
