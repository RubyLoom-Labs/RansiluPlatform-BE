const { getPool } = require('../config/db');

async function up(pool) {
  console.log('Running migration 033: Add is_main column to song relationship tables...');

  const columnExists = async (tableName, columnName) => {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    return cols.length > 0;
  };

  const addIsMainIfMissing = async (tableName) => {
    try {
      const exists = await columnExists(tableName, 'is_main');
      if (!exists) {
        console.log(`Adding is_main column to ${tableName}...`);
        await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN is_main TINYINT(1) DEFAULT 0`);
      }
    } catch (err) {
      console.warn(`Warning while altering ${tableName} column is_main:`, err.message);
    }
  };

  await addIsMainIfMissing('songSinger');
  await addIsMainIfMissing('songLyrics');
  await addIsMainIfMissing('songmusician');

  // Set is_main = 1 for existing records where no main artist is marked
  const setInitialMain = async (tableName) => {
    try {
      await pool.query(`
        UPDATE \`${tableName}\` t1
        JOIN (
          SELECT song_id, MIN(artist_id) as min_artist_id
          FROM \`${tableName}\`
          GROUP BY song_id
        ) t2 ON t1.song_id = t2.song_id AND t1.artist_id = t2.min_artist_id
        SET t1.is_main = 1
        WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT song_id FROM \`${tableName}\` WHERE is_main = 1) sub WHERE sub.song_id = t1.song_id
        )
      `);
    } catch (err) {
      console.warn(`Warning setting initial main in ${tableName}:`, err.message);
    }
  };

  await setInitialMain('songSinger');
  await setInitialMain('songLyrics');
  await setInitialMain('songmusician');

  console.log('Migration 033 completed successfully.');
}

module.exports = { up };
