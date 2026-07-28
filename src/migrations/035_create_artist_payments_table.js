async function up(pool) {
  console.log('Running migration 035: Create artist_payments table...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS artist_payments (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      artist_id     INT NOT NULL,
      amount        DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
      songs_count   INT            NOT NULL DEFAULT 0,
      period_label  VARCHAR(100)   NULL,
      paid_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
      status        INT            DEFAULT 1,
      is_delete     INT            DEFAULT 0,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 035 completed successfully.');
}

module.exports = { up };
