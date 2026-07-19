async function up(pool) {
  console.log('Running migration 006: Create SongConflict table...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS SongConflict (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      SongId INT NOT NULL,
      CopyrightConflict ENUM('Sound Records', 'Compositions') NOT NULL,
      ConflictOwner VARCHAR(255) NOT NULL,
      ConflictDate DATE NOT NULL,
      ResolveDate DATE NULL,
      Status INT DEFAULT 1,
      IsDeleted TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (SongId) REFERENCES songs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('Migration 006 completed successfully.');
}

module.exports = { up };
