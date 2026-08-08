-- RansiluPlatform-BE
-- Live-safe backfill for environments without `npm run migrate` (e.g., cPanel + phpMyAdmin)
-- This script:
-- 1) Recalculates songs.ownership from is_recordlabel/is_lyrics/is_musician for ALL existing songs
--    (RecordLabel=50, Lyrics=25, Musician=25) so it matches the ownership % already shown in the UI
-- 2) Records migration 039 as executed (if migrations table exists)
--
-- Run on the EXISTING production database (do not create a new DB).
-- Safe to re-run; it only recomputes a derived column, no data is deleted.

SET @db := DATABASE();

UPDATE songs
SET ownership = (
  COALESCE(is_recordlabel, 0) * 50 +
  COALESCE(is_lyrics, 0) * 25 +
  COALESCE(is_musician, 0) * 25
);

-- Mark migration 039 as applied if migrations table exists.
-- Safe no-op if already inserted.
SET @mig_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = @db
    AND table_name = 'migrations'
);

SET @mig_sql := IF(
  @mig_exists > 0,
  "INSERT INTO migrations (name) SELECT '039_backfill_song_ownership.js' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM migrations WHERE name = '039_backfill_song_ownership.js')",
  'SELECT 1'
);

PREPARE mig_stmt FROM @mig_sql;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

SELECT 'Ownership backfill completed' AS status;
