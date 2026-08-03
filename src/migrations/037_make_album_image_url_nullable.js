async function up(pool) {
  console.log('Running migration 037: Make album image_url nullable again...');

  await pool.query(`
    ALTER TABLE album MODIFY COLUMN image_url LONGTEXT NULL;
  `);

  console.log('Migration 037 completed successfully.');
}

module.exports = { up };
