async function up(pool) {
  console.log('Running migration 014: Make album image_url NOT NULL...');
  
  // First ensure no NULL image_url values exist before setting NOT NULL
  await pool.query(`UPDATE album SET image_url = '' WHERE image_url IS NULL;`);

  await pool.query(`
    ALTER TABLE album MODIFY COLUMN image_url LONGTEXT NOT NULL;
  `);

  console.log('Migration 014 completed successfully.');
}

module.exports = { up };

