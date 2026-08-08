-- RansiluPlatform-BE
-- Live-safe index patch for environments without `npm run migrate` (e.g., cPanel + phpMyAdmin)
-- This script:
-- 1) Adds only missing indexes (idempotent)
-- 2) Records migration 038 as executed (if migrations table exists)
--
-- Run on the EXISTING production database (do not create a new DB).
-- Recommended: run during low traffic hours because ALTER TABLE can lock writes.

SET @db := DATABASE();

DROP PROCEDURE IF EXISTS add_index_if_missing;
DELIMITER $$
CREATE PROCEDURE add_index_if_missing(
  IN p_table_name VARCHAR(128),
  IN p_index_name VARCHAR(128),
  IN p_index_cols VARCHAR(512)
)
BEGIN
  DECLARE idx_count INT DEFAULT 0;

  SELECT COUNT(*) INTO idx_count
  FROM information_schema.statistics
  WHERE table_schema = @db
    AND table_name = p_table_name
    AND index_name = p_index_name;

  IF idx_count = 0 THEN
    SET @sql_stmt = CONCAT(
      'ALTER TABLE `', p_table_name, '` ADD INDEX `', p_index_name, '` (', p_index_cols, ')'
    );
    PREPARE stmt FROM @sql_stmt;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- Base entity list/filter columns
CALL add_index_if_missing('songs', 'idx_songs_status_isdelete', 'status, is_delete');
CALL add_index_if_missing('songs', 'idx_songs_name', 'name');
CALL add_index_if_missing('songs', 'idx_songs_created_at', 'created_at');
CALL add_index_if_missing('artists', 'idx_artists_status_isdelete', 'status, is_delete');
CALL add_index_if_missing('artists', 'idx_artists_name', 'name');

-- Song relationship tables
CALL add_index_if_missing('songSinger', 'idx_songsinger_artist_status', 'artist_id, status, is_delete');
CALL add_index_if_missing('songLyrics', 'idx_songlyrics_artist_status', 'artist_id, status, is_delete');
CALL add_index_if_missing('songmusician', 'idx_songmusician_artist_status', 'artist_id, status, is_delete');
CALL add_index_if_missing('songdistributor', 'idx_songdistributor_dist_status', 'distributor_id, status, is_deleted');
CALL add_index_if_missing('songdistributor', 'idx_songdistributor_song_status', 'song_id, status, is_deleted');
CALL add_index_if_missing('songringintone', 'idx_songringintone_ring_status', 'ringintone_id, status');
CALL add_index_if_missing('songringintone', 'idx_songringintone_song_status', 'song_id, status');
CALL add_index_if_missing('songalbum', 'idx_songalbum_album_status', 'album_id, status, is_delete');
CALL add_index_if_missing('songalbum', 'idx_songalbum_song_status', 'song_id, status, is_delete');

-- Supporting lookup/filter tables
CALL add_index_if_missing('SongConflict', 'idx_songconflict_song_status', 'SongId, Status, IsDeleted');
CALL add_index_if_missing('notesandcases', 'idx_notesandcases_status_isdelete', 'status, is_delete');
CALL add_index_if_missing('record_label', 'idx_recordlabel_status_isdelete', 'status, is_delete');
CALL add_index_if_missing('album', 'idx_album_isdelete', 'is_delete');
CALL add_index_if_missing('distributors', 'idx_distributors_isdeleted', 'is_deleted');
CALL add_index_if_missing('ringintone', 'idx_ringintone_isdeleted_status', 'is_deleted, status');
CALL add_index_if_missing('ownership', 'idx_ownership_status_isdelete', 'status, is_delete');
CALL add_index_if_missing('ownershipsong', 'idx_ownershipsong_status_isdelete', 'status, is_delete');

-- Auth/permission tables (hit on nearly every secured request)
CALL add_index_if_missing('users', 'idx_users_isdelete_status', 'is_delete, status');
CALL add_index_if_missing('role_permissions', 'idx_roleperm_role_isdelete_status', 'role_id, is_delete, status');
CALL add_index_if_missing('permissions', 'idx_permissions_isdelete_status', 'is_delete, status');

DROP PROCEDURE IF EXISTS add_index_if_missing;

-- Mark migration 038 as applied if migrations table exists.
-- Safe no-op if already inserted.
SET @mig_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = @db
    AND table_name = 'migrations'
);

SET @mig_sql := IF(
  @mig_exists > 0,
  "INSERT INTO migrations (name) SELECT '038_add_performance_indexes.js' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM migrations WHERE name = '038_add_performance_indexes.js')",
  'SELECT 1'
);

PREPARE mig_stmt FROM @mig_sql;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

SELECT 'Performance index patch completed' AS status;
