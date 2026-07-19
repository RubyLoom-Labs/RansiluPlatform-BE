async function up(pool) {
  console.log('Running migration 007: Add is_deleted to distributors and songdistributor tables...');

  try {
    await pool.query(`
      ALTER TABLE distributors
      ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('is_deleted column already exists in distributors.');
    } else {
      throw err;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE songdistributor
      ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('is_deleted column already exists in songdistributor.');
    } else {
      throw err;
    }
  }

  console.log('Migration 007 completed successfully.');
}

module.exports = { up };
