async function up(pool) {
  console.log('Running migration 005: Add updated_date to songdistributor table...');

  // MySQL < 8.0.19 doesn't support IF NOT EXISTS in ALTER TABLE
  try {
    await pool.query(`
      ALTER TABLE songdistributor
      ADD COLUMN updated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('updated_date column already exists.');
    } else {
      throw err;
    }
  }

  // Back-fill existing rows
  await pool.query(`
    UPDATE songdistributor SET updated_date = CURRENT_TIMESTAMP WHERE updated_date IS NULL
  `);

  console.log('Migration 005 completed successfully.');
}

module.exports = { up };
