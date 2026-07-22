async function up(pool) {
  console.log('Running migration 017: Add is_delete column to songs table...');
  try {
    const [columns] = await pool.query("SHOW COLUMNS FROM songs LIKE 'is_delete'");
    if (columns.length === 0) {
      await pool.query('ALTER TABLE songs ADD COLUMN is_delete TINYINT(1) DEFAULT 0 AFTER status');
      console.log('Added is_delete column to songs table.');
    } else {
      console.log('is_delete column already exists in songs table.');
    }
  } catch (err) {
    console.error('Error adding is_delete to songs table:', err);
  }
}

module.exports = { up };
