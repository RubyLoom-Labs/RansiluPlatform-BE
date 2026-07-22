async function up(pool) {
  console.log('Running migration 013: Add is_delete column to artists table...');

  try {
    await pool.query(`
      ALTER TABLE artists
      ADD COLUMN is_delete INT DEFAULT 0
    `);
    console.log('is_delete column added to artists table.');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('is_delete column already exists in artists table.');
    } else {
      throw err;
    }
  }

  console.log('Migration 013 completed successfully.');
}

module.exports = {
  up,
};
