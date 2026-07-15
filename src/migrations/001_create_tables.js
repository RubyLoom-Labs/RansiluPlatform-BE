async function up(pool) {
  // Drop tables in reverse order of foreign keys
  console.log('Dropping existing tables to apply updated schema...');
  await pool.query('DROP TABLE IF EXISTS song_artists;');
  await pool.query('DROP TABLE IF EXISTS songs;');
  await pool.query('DROP TABLE IF EXISTS artists;');

  // 1. Create artists table
  console.log('Creating artists table...');
  await pool.query(`
    CREATE TABLE artists (
      id INT AUTO_INCREMENT PRIMARY KEY,
      artist_code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      gender ENUM('M', 'F', 'O') NOT NULL,
      music BOOLEAN DEFAULT FALSE,
      lyrics BOOLEAN DEFAULT FALSE,
      singer BOOLEAN DEFAULT FALSE,
      band BOOLEAN DEFAULT FALSE,
      other BOOLEAN DEFAULT FALSE,
      image VARCHAR(500),
      status BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 2. Create songs table
  console.log('Creating songs table...');
  await pool.query(`
    CREATE TABLE songs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      nameSinhala VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'Active',
      trackUrl VARCHAR(500),
      imageUrl VARCHAR(500),
      isrcCode VARCHAR(100),
      other TEXT,
      versionType VARCHAR(50) DEFAULT 'Original',
      versionName VARCHAR(255),
      originalSongId INT,
      distributionProvider VARCHAR(255),
      ringtoneProvider VARCHAR(255),
      ringtoneId VARCHAR(255),
      contentCode VARCHAR(255),
      addedDate DATE,
      ownership INT DEFAULT 100,
      notes VARCHAR(255) DEFAULT 'No Cases Or Notes',
      conflict VARCHAR(50) DEFAULT 'No',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (originalSongId) REFERENCES songs(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 3. Create song_artists junction table
  console.log('Creating song_artists table...');
  await pool.query(`
    CREATE TABLE song_artists (
      song_id INT NOT NULL,
      artist_id INT NOT NULL,
      role VARCHAR(50) NOT NULL,
      PRIMARY KEY (song_id, artist_id, role),
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Database schema successfully migrated.');
}

module.exports = {
  up,
};
