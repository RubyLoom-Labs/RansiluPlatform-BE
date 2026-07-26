async function up(pool) {
  console.log('Running migration 029: Resetting is_delete = 0 for non-deleted song relationship records...');

  // Reset is_delete = 0 for relationship records where parent song is not deleted (is_delete = 0)
  await pool.query(`
    UPDATE ownershipsong os JOIN songs s ON os.song_id = s.id 
    SET os.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE songalbum sa JOIN songs s ON sa.song_id = s.id 
    SET sa.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE SongConflict sc JOIN songs s ON sc.SongId = s.id 
    SET sc.IsDeleted = 0, sc.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE songdistributor sd JOIN songs s ON sd.song_id = s.id 
    SET sd.is_deleted = 0, sd.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE songLyrics sl JOIN songs s ON sl.song_id = s.id 
    SET sl.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE songmusician sm JOIN songs s ON sm.song_id = s.id 
    SET sm.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE songringintone sr JOIN songs s ON sr.song_id = s.id 
    SET sr.is_deleted = 0, sr.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  await pool.query(`
    UPDATE songSinger ss JOIN songs s ON ss.song_id = s.id 
    SET ss.is_delete = 0 
    WHERE s.is_delete = 0 OR s.is_delete IS NULL;
  `);

  console.log('Migration 029 completed successfully.');
}

module.exports = { up };
