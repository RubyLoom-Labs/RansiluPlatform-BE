async function up(pool) {
  console.log('Running migration 003: Creating distributors and ringtone tables with relationships...');

  // 1. Update existing songs with NULL/empty ISRC to a unique fallback code
  await pool.query("UPDATE songs SET isrcCode = CONCAT('ISRC_TEMP_', id) WHERE isrcCode IS NULL OR TRIM(isrcCode) = '';");

  // 2. Modify isrcCode to be NOT NULL and UNIQUE in songs table
  await pool.query("ALTER TABLE songs MODIFY COLUMN isrcCode VARCHAR(100) NOT NULL UNIQUE;");

  // 3. Drop columns from songs table
  // Check if columns exist before dropping them to avoid crashes if migration run multiple times or database is in partial state
  try {
    await pool.query("ALTER TABLE songs DROP COLUMN distributionProvider;");
  } catch (err) { console.log('distributionProvider column already dropped or not found'); }
  try {
    await pool.query("ALTER TABLE songs DROP COLUMN ringtoneProvider;");
  } catch (err) { console.log('ringtoneProvider column already dropped or not found'); }
  try {
    await pool.query("ALTER TABLE songs DROP COLUMN ringtoneId;");
  } catch (err) { console.log('ringtoneId column already dropped or not found'); }
  try {
    await pool.query("ALTER TABLE songs DROP COLUMN contentCode;");
  } catch (err) { console.log('contentCode column already dropped or not found'); }
  try {
    await pool.query("ALTER TABLE songs DROP COLUMN addedDate;");
  } catch (err) { console.log('addedDate column already dropped or not found'); }

  // 4. Create distributors table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distributors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      distributor_code VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      outgoing_percentage DECIMAL(5,2) NOT NULL,
      status BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 5. Create ringintone table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ringintone (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      company_logo VARCHAR(500),
      status BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 6. Create songdistributor mapping table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songdistributor (
      song_id INT NOT NULL,
      distributor_id INT NOT NULL,
      status BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (song_id, distributor_id),
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 7. Create songringintone mapping table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songringintone (
      song_id INT NOT NULL,
      ringintone_id INT NOT NULL,
      status BOOLEAN DEFAULT FALSE,
      ringtone_code VARCHAR(255),
      content_code VARCHAR(255),
      added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (song_id, ringintone_id),
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (ringintone_id) REFERENCES ringintone(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 003 completed successfully.');
}

module.exports = {
  up,
};
