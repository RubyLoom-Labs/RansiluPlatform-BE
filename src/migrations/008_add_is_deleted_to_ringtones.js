async function up(pool) {
  console.log('Running migration 008: Add is_deleted to ringintone and songringintone tables...');

  try {
    await pool.query(`
      ALTER TABLE ringintone
      ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('is_deleted column already exists in ringintone.');
    } else {
      throw err;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE songringintone
      ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('is_deleted column already exists in songringintone.');
    } else {
      throw err;
    }
  }

  console.log('Migration 008 completed successfully.');
}

module.exports = { up };
