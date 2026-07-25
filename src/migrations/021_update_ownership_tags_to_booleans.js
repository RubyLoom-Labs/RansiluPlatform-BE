async function up(pool) {
  console.log('Running migration 021: Update ownership table document_tag to boolean columns...');

  async function columnExists(table, column) {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `, [table, column]);
    return rows.length > 0;
  }

  // 1. Add is_singer, is_lyrics, is_musician, is_recordlabel to ownership table
  const ownershipCols = ['is_singer', 'is_lyrics', 'is_musician', 'is_recordlabel'];
  for (const col of ownershipCols) {
    const exists = await columnExists('ownership', col);
    if (!exists) {
      console.log(`Adding ${col} to ownership table...`);
      await pool.query(`ALTER TABLE ownership ADD COLUMN ${col} TINYINT(1) DEFAULT 0;`);
    }
  }

  // 2. Migrate existing document_tag text to boolean columns if document_tag exists
  const hasDocumentTag = await columnExists('ownership', 'document_tag');
  if (hasDocumentTag) {
    console.log('Migrating existing document_tag text into boolean flags...');
    const [rows] = await pool.query('SELECT id, document_tag FROM ownership WHERE document_tag IS NOT NULL');
    for (const r of rows) {
      const tagStr = String(r.document_tag || '').toLowerCase();
      let isSinger = 0;
      let isLyrics = 0;
      let isMusician = 0;
      let isRecordLabel = 0;

      if (tagStr.includes('singer') || tagStr.includes('sing')) isSinger = 1;
      if (tagStr.includes('lyric')) isLyrics = 1;
      if (tagStr.includes('music') || tagStr.includes('melody')) isMusician = 1;
      if (tagStr.includes('recode') || tagStr.includes('record') || tagStr.includes('label')) isRecordLabel = 1;

      await pool.query(
        `UPDATE ownership SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ? WHERE id = ?`,
        [isSinger, isLyrics, isMusician, isRecordLabel, r.id]
      );
    }

    console.log('Dropping document_tag column from ownership table...');
    await pool.query('ALTER TABLE ownership DROP COLUMN document_tag;');
  }

  console.log('Migration 021 completed successfully.');
}

module.exports = { up };
