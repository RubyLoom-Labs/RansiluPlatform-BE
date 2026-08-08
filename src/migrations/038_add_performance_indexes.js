// Adds indexes on columns that are heavily used in WHERE/JOIN/ORDER BY clauses
// across the listing endpoints (songs, artists, distributors, record labels, etc.)
// but were added via later ALTER TABLE statements without an index, causing full
// table scans under load. Foreign-key columns already have an auto-created index
// from InnoDB, so those are intentionally skipped here.
async function up(pool) {
  console.log('Running migration 038: Adding performance indexes...');

  const addIndex = async (table, indexName, columns) => {
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`);
      console.log(`Added index ${indexName} on ${table}(${columns}).`);
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log(`Index ${indexName} already exists on ${table}. Skipping.`);
      } else {
        console.warn(`Warning while adding index ${indexName} on ${table}:`, err.message);
      }
    }
  };

  const indexes = [
    // Base entity list/filter columns
    ['songs', 'idx_songs_status_isdelete', 'status, is_delete'],
    ['songs', 'idx_songs_name', 'name'],
    ['songs', 'idx_songs_created_at', 'created_at'],
    ['artists', 'idx_artists_status_isdelete', 'status, is_delete'],
    ['artists', 'idx_artists_name', 'name'],

    // Song relationship (junction) tables - composite with the status flags used in every join
    ['songSinger', 'idx_songsinger_artist_status', 'artist_id, status, is_delete'],
    ['songLyrics', 'idx_songlyrics_artist_status', 'artist_id, status, is_delete'],
    ['songmusician', 'idx_songmusician_artist_status', 'artist_id, status, is_delete'],
    ['songdistributor', 'idx_songdistributor_dist_status', 'distributor_id, status, is_deleted'],
    ['songdistributor', 'idx_songdistributor_song_status', 'song_id, status, is_deleted'],
    ['songringintone', 'idx_songringintone_ring_status', 'ringintone_id, status'],
    ['songringintone', 'idx_songringintone_song_status', 'song_id, status'],
    ['songalbum', 'idx_songalbum_album_status', 'album_id, status, is_delete'],
    ['songalbum', 'idx_songalbum_song_status', 'song_id, status, is_delete'],

    // Lookup/filter columns queried on every song fetch
    ['SongConflict', 'idx_songconflict_song_status', 'SongId, Status, IsDeleted'],
    ['notesandcases', 'idx_notesandcases_status_isdelete', 'status, is_delete'],

    // Other listing endpoints with the same status/is_delete filter pattern
    ['record_label', 'idx_recordlabel_status_isdelete', 'status, is_delete'],
    ['album', 'idx_album_isdelete', 'is_delete'],
    ['distributors', 'idx_distributors_isdeleted', 'is_deleted'],
    ['ringintone', 'idx_ringintone_isdeleted_status', 'is_deleted, status'],
    ['ownership', 'idx_ownership_status_isdelete', 'status, is_delete'],
    ['ownershipsong', 'idx_ownershipsong_status_isdelete', 'status, is_delete'],

    // Auth/permission checks run on every authenticated request
    ['users', 'idx_users_isdelete_status', 'is_delete, status'],
    ['role_permissions', 'idx_roleperm_role_isdelete_status', 'role_id, is_delete, status'],
    ['permissions', 'idx_permissions_isdelete_status', 'is_delete, status'],
  ];

  for (const [table, indexName, columns] of indexes) {
    await addIndex(table, indexName, columns);
  }

  console.log('Migration 038 completed successfully.');
}

module.exports = { up };
