async function up(pool) {
  console.log('Running migration 010: Create record_label and songrecordlabel tables...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS record_label (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      image_url LONGTEXT NULL,
      status TINYINT(1) DEFAULT 1,
      is_delete TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS songrecordlabel (
      id INT AUTO_INCREMENT PRIMARY KEY,
      song_id INT NOT NULL,
      record_label_id INT NOT NULL,
      status TINYINT(1) DEFAULT 1,
      is_delete TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (record_label_id) REFERENCES record_label(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 010 completed successfully.');
}

module.exports = { up };
