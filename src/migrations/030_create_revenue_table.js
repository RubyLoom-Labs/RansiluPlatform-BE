async function up(pool) {
  console.log('Running migration 030: Create revenue table...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue (
      id INT AUTO_INCREMENT PRIMARY KEY,
      song_id INT NOT NULL,
      isrc_code VARCHAR(100) NULL,
      song_name VARCHAR(255) NULL,
      date VARCHAR(50) NULL,
      amount DECIMAL(12, 2) DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 030 completed successfully.');
}

module.exports = { up };
