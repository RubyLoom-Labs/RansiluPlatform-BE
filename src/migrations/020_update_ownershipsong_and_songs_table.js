async function up(pool) {
  console.log('Running migration 020: Update ownershipsong and songs tables for multi-ownership flags...');

  // Helper to check if a column exists in a table
  async function columnExists(table, column) {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `, [table, column]);
    return rows.length > 0;
  }

  // 1. Alter ownershipsong table: Add is_singer, is_lyrics, is_musician, is_recordlabel
  const ownershipsongCols = ['is_singer', 'is_lyrics', 'is_musician', 'is_recordlabel'];
  for (const col of ownershipsongCols) {
    const exists = await columnExists('ownershipsong', col);
    if (!exists) {
      console.log(`Adding ${col} to ownershipsong table...`);
      await pool.query(`ALTER TABLE ownershipsong ADD COLUMN ${col} TINYINT(1) DEFAULT 0;`);
    }
  }

  // 2. Migrate existing ownership_type data if ownership_type column exists
  const hasOwnershipType = await columnExists('ownershipsong', 'ownership_type');
  if (hasOwnershipType) {
    console.log('Migrating existing ownership_type data into boolean flags...');
    const [rows] = await pool.query('SELECT id, ownership_type FROM ownershipsong WHERE ownership_type IS NOT NULL');
    for (const r of rows) {
      const oType = String(r.ownership_type || '').toLowerCase();
      let isSinger = 0;
      let isLyrics = 0;
      let isMusician = 0;
      let isRecordLabel = 0;

      if (oType.includes('singer') || oType.includes('sing')) isSinger = 1;
      if (oType.includes('lyric')) isLyrics = 1;
      if (oType.includes('music') || oType.includes('melody')) isMusician = 1;
      if (oType.includes('recode') || oType.includes('record') || oType.includes('label')) isRecordLabel = 1;

      // Default fallback if unknown type
      if (!isSinger && !isLyrics && !isMusician && !isRecordLabel) {
        isMusician = 1;
      }

      await pool.query(
        `UPDATE ownershipsong SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ? WHERE id = ?`,
        [isSinger, isLyrics, isMusician, isRecordLabel, r.id]
      );
    }

    console.log('Dropping ownership_type column from ownershipsong...');
    await pool.query('ALTER TABLE ownershipsong DROP COLUMN ownership_type;');
  }

  // 3. Alter songs table: Add is_singer, is_lyrics, is_musician, is_recordlabel
  const songsCols = ['is_singer', 'is_lyrics', 'is_musician', 'is_recordlabel'];
  for (const col of songsCols) {
    const exists = await columnExists('songs', col);
    if (!exists) {
      console.log(`Adding ${col} to songs table...`);
      await pool.query(`ALTER TABLE songs ADD COLUMN ${col} TINYINT(1) DEFAULT 0;`);
    }
  }

  // 4. Initial synchronization for all songs
  console.log('Performing initial song ownership synchronization...');
  await pool.query(`
    UPDATE songs s
    LEFT JOIN (
      SELECT 
        os.song_id,
        MAX(os.is_singer) AS is_singer,
        MAX(os.is_lyrics) AS is_lyrics,
        MAX(os.is_musician) AS is_musician,
        MAX(os.is_recordlabel) AS is_recordlabel
      FROM ownershipsong os
      JOIN ownership o ON os.ownership_id = o.id
      WHERE os.status = 1 AND os.is_delete = 0 AND o.status = 1 AND o.is_delete = 0
      GROUP BY os.song_id
    ) calc ON s.id = calc.song_id
    SET 
      s.is_singer = COALESCE(calc.is_singer, 0),
      s.is_lyrics = COALESCE(calc.is_lyrics, 0),
      s.is_musician = COALESCE(calc.is_musician, 0),
      s.is_recordlabel = COALESCE(calc.is_recordlabel, 0);
  `);

  console.log('Migration 020 completed successfully.');
}

module.exports = { up };
