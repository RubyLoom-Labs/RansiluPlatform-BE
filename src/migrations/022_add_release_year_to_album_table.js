async function up(pool) {
  console.log('Running migration 022: Add release_year column to album table...');

  try {
    const [columns] = await pool.query(`SHOW COLUMNS FROM album LIKE 'release_year'`);
    if (columns.length === 0) {
      await pool.query(`
        ALTER TABLE album 
        ADD COLUMN release_year VARCHAR(10) DEFAULT NULL AFTER record_label_id
      `);
      console.log('Added release_year column to album table successfully.');
    } else {
      console.log('Column release_year already exists in album table.');
    }
  } catch (error) {
    console.error('Error running migration 022:', error);
    throw error;
  }
}

module.exports = { up };
