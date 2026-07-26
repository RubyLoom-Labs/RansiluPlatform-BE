const { getPool } = require('../config/db');

async function up(pool) {
  console.log('Running migration 028: Add status and is_delete columns to song relationship tables if missing...');

  const columnExists = async (tableName, columnName) => {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    return cols.length > 0;
  };

  const addColumnIfMissing = async (tableName, columnName, definition) => {
    try {
      const exists = await columnExists(tableName, columnName);
      if (!exists) {
        console.log(`Adding ${columnName} to ${tableName}...`);
        await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnName} ${definition}`);
      }
    } catch (err) {
      console.warn(`Warning while altering ${tableName} column ${columnName}:`, err.message);
    }
  };

  // 1. songSinger
  await addColumnIfMissing('songSinger', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('songSinger', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 2. songLyrics
  await addColumnIfMissing('songLyrics', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('songLyrics', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 3. songmusician
  await addColumnIfMissing('songmusician', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('songmusician', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 4. songalbum
  await addColumnIfMissing('songalbum', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('songalbum', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 5. songdistributor
  await addColumnIfMissing('songdistributor', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('songdistributor', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 6. songringintone
  await addColumnIfMissing('songringintone', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('songringintone', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 7. SongConflict
  await addColumnIfMissing('SongConflict', 'Status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('SongConflict', 'IsDeleted', 'TINYINT(1) DEFAULT 0');
  await addColumnIfMissing('SongConflict', 'is_delete', 'TINYINT(1) DEFAULT 0');

  // 8. ownershipsong
  await addColumnIfMissing('ownershipsong', 'status', 'TINYINT(1) DEFAULT 1');
  await addColumnIfMissing('ownershipsong', 'is_delete', 'TINYINT(1) DEFAULT 0');

  console.log('Migration 028 completed successfully.');
}

module.exports = {
  up,
};
