// Backfills songs.ownership from is_recordlabel/is_lyrics/is_musician so it matches
// the % shown in the UI (RecordLabel=50, Lyrics=25, Musician=25). Idempotent - safe to re-run.
async function up(pool) {
  console.log('Running migration 039: Backfill songs.ownership from ownership flags...');

  await pool.query(`
    UPDATE songs
    SET ownership = (
      COALESCE(is_recordlabel, 0) * 50 +
      COALESCE(is_lyrics, 0) * 25 +
      COALESCE(is_musician, 0) * 25
    )
  `);

  console.log('Migration 039 completed: songs.ownership backfilled.');
}

module.exports = { up };
