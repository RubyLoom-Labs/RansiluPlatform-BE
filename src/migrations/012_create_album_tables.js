async function up(pool) {
  console.log('Running migration 012: Create album and songalbum tables...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS album (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      image_url LONGTEXT NULL,
      record_label_id INT NULL,
      is_delete TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (record_label_id) REFERENCES record_label(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS songalbum (
      id INT AUTO_INCREMENT PRIMARY KEY,
      song_id INT NOT NULL,
      album_id INT NOT NULL,
      status TINYINT(1) DEFAULT 1,
      is_delete TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 012 completed successfully.');
}

module.exports = { up };
