async function up(pool) {
  console.log('Running migration 018: Create ownership and ownershipsong tables...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ownership (
      id INT AUTO_INCREMENT PRIMARY KEY,
      document_name VARCHAR(255) NOT NULL,
      document_tag VARCHAR(255) NULL,
      is_ownership TINYINT(1) DEFAULT 1,
      document_url TEXT NULL,
      status TINYINT(1) DEFAULT 1,
      is_delete TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ownershipsong (
      id INT AUTO_INCREMENT PRIMARY KEY,
      song_id INT NOT NULL,
      ownership_id INT NOT NULL,
      ownership_type VARCHAR(100) NULL,
      status TINYINT(1) DEFAULT 1,
      is_delete TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      FOREIGN KEY (ownership_id) REFERENCES ownership(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Seed sample ownership and ownershipsong records if empty
  const [existingDocs] = await pool.query('SELECT COUNT(*) as count FROM ownership');
  if (existingDocs[0].count === 0) {
    console.log('Seeding initial ownership records...');
    
    // Fetch available song IDs
    const [songRows] = await pool.query('SELECT id FROM songs ORDER BY id ASC LIMIT 10');
    const songIds = songRows.map(s => s.id);

    const initialDocs = [
      { document_name: 'A102', document_tag: 'Chamara, aradana, ransilu', is_ownership: 1 },
      { document_name: 'A103', document_tag: 'Chamara, aradana, ransilu', is_ownership: 1 },
      { document_name: 'B204', document_tag: 'aradana, ransilu', is_ownership: 0 },
      { document_name: 'C301', document_tag: 'Chamara, ransilu', is_ownership: 1 }
    ];

    for (const doc of initialDocs) {
      const [res] = await pool.query(
        `INSERT INTO ownership (document_name, document_tag, is_ownership, status, is_delete)
         VALUES (?, ?, ?, 1, 0)`,
        [doc.document_name, doc.document_tag, doc.is_ownership]
      );
      const ownershipId = res.insertId;

      // Link songs if songs exist, or fallback
      if (songIds.length > 0) {
        for (const sId of songIds.slice(0, 3)) {
          await pool.query(
            `INSERT INTO ownershipsong (song_id, ownership_id, status, is_delete)
             VALUES (?, ?, 1, 0)`,
            [sId, ownershipId]
          );
        }
      }
    }
  }

  console.log('Migration 018 completed successfully.');
}

module.exports = { up };
