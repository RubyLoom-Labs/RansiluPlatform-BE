async function up(pool) {
  console.log('Running migration 002: Updating song tables schema...');

  // 1. Update status values to numeric/boolean representations
  await pool.query("UPDATE songs SET status = '1' WHERE status = 'Active';");
  await pool.query("UPDATE songs SET status = '0' WHERE status = 'Inactive';");

  // 2. Modify songs.status column to BOOLEAN DEFAULT TRUE
  console.log('Modifying songs.status column to BOOLEAN...');
  await pool.query("ALTER TABLE songs MODIFY COLUMN status BOOLEAN DEFAULT TRUE;");

  // 3. Drop unified song_artists table if exists
  console.log('Dropping unified song_artists table...');
  await pool.query("DROP TABLE IF EXISTS song_artists;");

  // 4. Create separate many-to-many relationship tables
  console.log('Creating songSinger mapping table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songSinger (
      song_id INT NOT NULL,
      artist_id INT NOT NULL,
      PRIMARY KEY (song_id, artist_id),
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Creating songLyrics mapping table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songLyrics (
      song_id INT NOT NULL,
      artist_id INT NOT NULL,
      PRIMARY KEY (song_id, artist_id),
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Creating songmusician mapping table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songmusician (
      song_id INT NOT NULL,
      artist_id INT NOT NULL,
      PRIMARY KEY (song_id, artist_id),
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 002 completed successfully.');
}

module.exports = {
  up,
};
