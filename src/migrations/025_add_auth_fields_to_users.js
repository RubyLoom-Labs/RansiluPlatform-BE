const { getPool } = require('../config/db');

async function up(passedPool) {
  const pool = passedPool || getPool();

  console.log('Running migration 025: Add authentication & password reset fields to users table...');

  // Check columns in users table
  const [columns] = await pool.query(`SHOW COLUMNS FROM users`);
  const columnNames = columns.map(c => c.Field);

  if (!columnNames.includes('refresh_token')) {
    await pool.query(`ALTER TABLE users ADD COLUMN refresh_token TEXT NULL AFTER password`);
  }

  if (!columnNames.includes('reset_token')) {
    await pool.query(`ALTER TABLE users ADD COLUMN reset_token VARCHAR(255) NULL AFTER refresh_token`);
  }

  if (!columnNames.includes('reset_token_expires')) {
    await pool.query(`ALTER TABLE users ADD COLUMN reset_token_expires DATETIME NULL AFTER reset_token`);
  }

  console.log('Migration 025 completed successfully.');
}

async function down(passedPool) {
  const pool = passedPool || getPool();
  await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS reset_token_expires`);
  await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS reset_token`);
  await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS refresh_token`);
}

module.exports = { up, down };
