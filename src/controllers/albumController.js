const { getPool } = require('../config/db');

// Helper to convert string to Title Case
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Helper to convert string to simple letters (lowercase, no spaces, no special characters)
function toSimpleLetters(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Helper for formatting image URLs
function formatImage(img, host) {
  if (!img || typeof img !== 'string') return null;
  const trimmed = img.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http') || trimmed.startsWith('data:')) return trimmed;
  return `${host}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

// GET /albums
exports.getAlbums = async (req, res) => {
  try {
    const pool = getPool();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const isExport = req.query.export === 'true';

    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'az';
    const labelId = req.query.labelId;
    const trackCount = req.query.trackCount;

    let whereClauses = ['a.is_delete = 0'];
    let queryParams = [];

    if (search) {
      const searchSimple = toSimpleLetters(search);
      whereClauses.push('(a.name LIKE ? OR a.display_name LIKE ?)');
      queryParams.push(`%${searchSimple}%`, `%${search}%`);
    }

    if (labelId) {
      whereClauses.push('a.record_label_id = ?');
      queryParams.push(parseInt(labelId, 10));
    }

    const whereClauseStr = 'WHERE ' + whereClauses.join(' AND ');

    let havingClause = '';
    if (trackCount !== undefined && trackCount !== null && trackCount !== '') {
      havingClause = 'HAVING songCount = ?';
    }

    // Determine sort order
    let orderByClause = 'ORDER BY a.display_name ASC, a.name ASC';
    if (sortBy === 'za') {
      orderByClause = 'ORDER BY a.display_name DESC, a.name DESC';
    } else if (sortBy === 'newest') {
      orderByClause = 'ORDER BY a.created_at DESC';
    } else if (sortBy === 'oldest') {
      orderByClause = 'ORDER BY a.created_at ASC';
    }

    // Main query
    let dataQuery = `
      SELECT a.*, rl.display_name as labelName, COUNT(DISTINCT sa.song_id) as songCount
      FROM album a
      LEFT JOIN record_label rl ON a.record_label_id = rl.id AND rl.is_delete = 0
      LEFT JOIN songalbum sa ON a.id = sa.album_id AND sa.status = 1 AND sa.is_delete = 0
      ${whereClauseStr}
      GROUP BY a.id
      ${havingClause}
      ${orderByClause}
    `;

    let countQueryParams = [...queryParams];
    if (havingClause) {
      countQueryParams.push(parseInt(trackCount, 10));
    }

    // Count query
    let countQuery = `
      SELECT COUNT(*) as total FROM (
        SELECT a.id, COUNT(DISTINCT sa.song_id) as songCount
        FROM album a
        LEFT JOIN songalbum sa ON a.id = sa.album_id AND sa.status = 1 AND sa.is_delete = 0
        ${whereClauseStr}
        GROUP BY a.id
        ${havingClause}
      ) sub
    `;

    const [countRows] = await pool.query(countQuery, countQueryParams);
    const totalCount = countRows.length > 0 ? countRows[0].total : 0;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, countQueryParams);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [...countQueryParams, limit, offset]);
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const formattedList = rows.map(r => {
      const img = formatImage(r.image_url, host);
      return {
        id: r.id,
        name: r.display_name || toTitleCase(r.name),
        rawName: r.name,
        imageUrl: img,
        image_url: img,
        recordLabelId: r.record_label_id,
        recordLabelName: r.labelName || '—',
        songCount: r.songCount || 0,
        release_year: r.release_year || '',
        releaseYear: r.release_year || '',
        status: 'Active',
        created_at: r.created_at,
        updated_at: r.updated_at
      };
    });

    res.json({
      albums: formattedList,
      data: formattedList,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      totalRecords: totalCount,
      totalCount
    });
  } catch (error) {
    console.error('Error fetching albums:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /albums/search
exports.searchAlbums = async (req, res) => {
  req.query.search = req.query.keyword || req.query.search || '';
  return exports.getAlbums(req, res);
};

// GET /albums/export
exports.exportAlbums = async (req, res) => {
  req.query.export = 'true';
  return exports.getAlbums(req, res);
};

async function fetchSongLabelsMap(songIds, pool, host) {
  if (!Array.isArray(songIds) || songIds.length === 0) return {};
  const [labelRelations] = await pool.query(`
    SELECT sa.song_id, rl.id as label_id, COALESCE(rl.display_name, rl.name) as label_name, rl.image_url as label_image
    FROM songalbum sa
    JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
    JOIN record_label rl ON a.record_label_id = rl.id 
      AND (rl.status = 1 OR rl.status IS NULL) 
      AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
    WHERE sa.song_id IN (?) AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
  `, [songIds]);

  const songLabels = {};
  labelRelations.forEach((rel) => {
    if (!songLabels[rel.song_id]) {
      songLabels[rel.song_id] = [];
    }
    if (rel.label_name && !songLabels[rel.song_id].some(l => String(l.id) === String(rel.label_id))) {
      const img = rel.label_image;
      const formattedImg = formatImage(img, host);
      songLabels[rel.song_id].push({
        id: rel.label_id,
        name: toTitleCase(rel.label_name),
        imageUrl: formattedImg,
        image_url: formattedImg
      });
    }
  });

  return songLabels;
}

async function fetchSongConflictsMap(songIds, pool) {
  if (!Array.isArray(songIds) || songIds.length === 0) return {};
  try {
    const [rows] = await pool.query(
      `SELECT SongId, COUNT(*) as count 
       FROM SongConflict 
       WHERE SongId IN (?) AND Status = 1 AND (IsDeleted = 0 OR IsDeleted IS NULL)
       GROUP BY SongId`,
      [songIds]
    );
    const map = {};
    rows.forEach(r => {
      map[r.SongId] = r.count;
    });
    return map;
  } catch (err) {
    console.error('Error fetching song conflicts map:', err);
    return {};
  }
}

// GET /albums/:id (Basic details only for fast initial load)
exports.getAlbumById = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const [rows] = await pool.query(`
      SELECT a.*, rl.display_name as labelName, rl.image_url as labelImage,
             (SELECT COUNT(*) 
              FROM songalbum sa 
              JOIN songs s ON sa.song_id = s.id
              WHERE sa.album_id = a.id 
                AND (sa.status = 1 OR sa.status IS NULL) 
                AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
                AND (s.status = 1 OR s.status IS NULL)
             ) as songCount
      FROM album a
      LEFT JOIN record_label rl ON a.record_label_id = rl.id AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
      WHERE a.id = ? AND a.is_delete = 0
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Album not found' });
    }

    const r = rows[0];
    const img = formatImage(r.image_url, host);

    // Fetch attached active songs for this album
    const [attachedSongs] = await pool.query(`
      SELECT s.id, s.name
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
      WHERE sa.album_id = ? 
        AND (sa.status = 1 OR sa.status IS NULL) 
        AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
      ORDER BY s.name ASC
    `, [id]);

    const formattedSongs = attachedSongs.map(s => ({
      id: s.id,
      name: toTitleCase(s.name)
    }));

    res.json({
      id: r.id,
      name: r.display_name || toTitleCase(r.name),
      rawName: r.name,
      imageUrl: img,
      image_url: img,
      recordLabelId: r.record_label_id,
      recordLabelName: r.labelName || '—',
      recordLabelImage: formatImage(r.labelImage, host),
      songCount: r.songCount || 0,
      release_year: r.release_year || '',
      releaseYear: r.release_year || '',
      songs: formattedSongs,
      song_ids: formattedSongs.map(s => s.id),
      created_at: r.created_at,
      updated_at: r.updated_at
    });
  } catch (error) {
    console.error('Error fetching album details:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /albums/:id/songs (Lazy-loaded when clicking Songs sub-tab with pagination)
exports.getAlbumSongs = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    // Get album label info for fallback
    const [albumRows] = await pool.query(`
      SELECT a.record_label_id, rl.display_name as labelName, rl.image_url as labelImage
      FROM album a
      LEFT JOIN record_label rl ON a.record_label_id = rl.id AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
      WHERE a.id = ? AND a.is_delete = 0
    `, [id]);

    const r = albumRows[0] || {};
    const albumLabelImage = formatImage(r.labelImage, host);
    const albumLabelObj = r.record_label_id ? [{
      id: r.record_label_id,
      name: toTitleCase(r.labelName || ''),
      imageUrl: albumLabelImage,
      image_url: albumLabelImage
    }] : [];

    // Count query
    const [countRows] = await pool.query(`
      SELECT COUNT(DISTINCT sa.song_id) as total
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id
      WHERE sa.album_id = ?
        AND (sa.status = 1 OR sa.status IS NULL)
        AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
        AND (s.status = 1 OR s.status IS NULL)
    `, [id]);
    const totalCount = countRows[0] ? countRows[0].total : 0;

    const isExport = req.query.export === 'true';

    // Fetch related songs
    let dataQuery = `
      SELECT s.id, s.name, s.imageUrl, s.isrcCode, s.versionType,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id) as artist,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songLyrics sl JOIN artists art ON sl.artist_id = art.id WHERE sl.song_id = s.id) as lyricist,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songmusician sm JOIN artists art ON sm.artist_id = art.id WHERE sm.song_id = s.id) as musician
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id
      WHERE sa.album_id = ? 
        AND (sa.status = 1 OR sa.status IS NULL) 
        AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
        AND (s.status = 1 OR s.status IS NULL)
      ORDER BY s.name ASC
    `;

    let songRows;
    if (isExport) {
      [songRows] = await pool.query(dataQuery, [id]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [songRows] = await pool.query(dataQuery, [id, limit, offset]);
    }

    const songIds = songRows.map(s => s.id);
    const songLabelsMap = await fetchSongLabelsMap(songIds, pool, host);
    const songConflictsMap = await fetchSongConflictsMap(songIds, pool);

    const formattedSongs = songRows.map(s => {
      const parsedLabels = songLabelsMap[s.id] || [];
      const songLabelList = parsedLabels.length > 0 ? parsedLabels : albumLabelObj;
      const cCount = songConflictsMap[s.id] || 0;
      const conflictText = cCount > 0 ? `${cCount} ${cCount === 1 ? 'Conflict' : 'Conflicts'}` : 'No';
      return {
        id: s.id,
        name: toTitleCase(s.name),
        artist: toTitleCase(s.artist) || 'Unknown Artist',
        lyrics: toTitleCase(s.lyricist) || '—',
        music: toTitleCase(s.musician) || '—',
        imageUrl: formatImage(s.imageUrl, host),
        duration: '03:45',
        isrcCode: s.isrcCode || '—',
        versionType: s.versionType || 'Original',
        conflictCount: cCount,
        conflicts: conflictText,
        conflict: conflictText,
        labels: songLabelList,
        recordLabels: songLabelList,
        labelNames: songLabelList.map(l => l.name).join(', ') || 'None'
      };
    });

    res.json({
      songs: formattedSongs,
      songCount: totalCount,
      totalCount,
      hasMore: offset + formattedSongs.length < totalCount
    });
  } catch (error) {
    console.error('Error fetching album songs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /albums/:id/artists (Lazy-loaded when clicking Artists sub-tab)
exports.getAlbumArtists = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const [rows] = await pool.query(`
      SELECT a.id, a.name, a.image as image_url, 'Singer' as role
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
      JOIN songSinger ss ON s.id = ss.song_id
      JOIN artists a ON ss.artist_id = a.id AND (a.status = 1 OR a.status IS NULL) AND (a.is_delete = 0 OR a.is_delete IS NULL)
      WHERE sa.album_id = ? AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)

      UNION ALL

      SELECT a.id, a.name, a.image as image_url, 'Lyricist' as role
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
      JOIN songLyrics sl ON s.id = sl.song_id
      JOIN artists a ON sl.artist_id = a.id AND (a.status = 1 OR a.status IS NULL) AND (a.is_delete = 0 OR a.is_delete IS NULL)
      WHERE sa.album_id = ? AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)

      UNION ALL

      SELECT a.id, a.name, a.image as image_url, 'Musician' as role
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
      JOIN songmusician sm ON s.id = sm.song_id
      JOIN artists a ON sm.artist_id = a.id AND (a.status = 1 OR a.status IS NULL) AND (a.is_delete = 0 OR a.is_delete IS NULL)
      WHERE sa.album_id = ? AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
    `, [id, id, id]);

    const artistMap = {};
    const uniqueSingers = new Set();
    const uniqueLyricists = new Set();
    const uniqueMusicians = new Set();

    rows.forEach(r => {
      if (r.role === 'Singer') uniqueSingers.add(r.id);
      if (r.role === 'Lyricist') uniqueLyricists.add(r.id);
      if (r.role === 'Musician') uniqueMusicians.add(r.id);

      if (!artistMap[r.id]) {
        const formattedImg = formatImage(r.image_url, host);
        artistMap[r.id] = {
          id: r.id,
          name: toTitleCase(r.name),
          image_url: formattedImg,
          imageUrl: formattedImg,
          avatar: formattedImg,
          roles: []
        };
      }
      if (!artistMap[r.id].roles.includes(r.role)) {
        artistMap[r.id].roles.push(r.role);
      }
    });

    const artists = Object.values(artistMap);

    res.json({
      summary: {
        singers: uniqueSingers.size,
        lyricists: uniqueLyricists.size,
        musicians: uniqueMusicians.size
      },
      artists
    });
  } catch (error) {
    console.error('Error fetching album artists:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /albums
exports.createAlbum = async (req, res) => {
  try {
    const pool = getPool();
    const { name, image_url, record_label_id, song_ids, release_year, releaseYear } = req.body;
    const relYear = release_year || releaseYear || null;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Album name is required' });
    }

    if (!image_url || (typeof image_url === 'string' && !image_url.trim())) {
      return res.status(400).json({ message: 'Album cover image is required' });
    }

    const convertedName = toSimpleLetters(name);
    const displayName = name.trim();

    if (!convertedName) {
      return res.status(400).json({ message: 'Invalid album name format' });
    }

    // Check duplicate against non-deleted records
    const [existing] = await pool.query(
      `SELECT id FROM album WHERE name = ? AND is_delete = 0`,
      [convertedName]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Album already exists.' });
    }

    const labelId = record_label_id ? parseInt(record_label_id, 10) : null;

    const [result] = await pool.query(
      `INSERT INTO album (name, display_name, image_url, record_label_id, release_year, is_delete)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [convertedName, displayName, image_url, labelId, relYear]
    );

    const albumId = result.insertId;

    // Associate songs if provided
    if (Array.isArray(song_ids) && song_ids.length > 0) {
      for (const songId of song_ids) {
        await pool.query(
          `INSERT INTO songalbum (song_id, album_id, status, is_delete)
           VALUES (?, ?, 1, 0)`,
          [parseInt(songId, 10), albumId]
        );
      }
    }

    res.status(201).json({
      message: 'Album created successfully',
      id: albumId
    });
  } catch (error) {
    console.error('Error creating album:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /albums/:id
exports.updateAlbum = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const { name, image_url, record_label_id, song_ids, release_year, releaseYear } = req.body;
    const relYear = release_year || releaseYear || null;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Album name is required' });
    }

    if (!image_url || (typeof image_url === 'string' && !image_url.trim())) {
      return res.status(400).json({ message: 'Album cover image is required' });
    }

    const convertedName = toSimpleLetters(name);
    const displayName = name.trim();

    // Check duplicate name against non-deleted records excluding current id
    const [existing] = await pool.query(
      `SELECT id FROM album WHERE name = ? AND is_delete = 0 AND id != ?`,
      [convertedName, id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Album already exists.' });
    }

    const labelId = record_label_id ? parseInt(record_label_id, 10) : null;

    await pool.query(
      `UPDATE album 
       SET name = ?, display_name = ?, image_url = ?, record_label_id = ?, release_year = ?
       WHERE id = ? AND is_delete = 0`,
      [convertedName, displayName, image_url || null, labelId, relYear, id]
    );

    // Sync songalbum relationships if song_ids array is provided
    if (Array.isArray(song_ids)) {
      // Mark all current relationships as inactive/deleted
      await pool.query(
        `UPDATE songalbum SET status = 0, is_delete = 1 WHERE album_id = ?`,
        [id]
      );

      for (const songId of song_ids) {
        const sId = parseInt(songId, 10);
        const [existRel] = await pool.query(
          `SELECT id FROM songalbum WHERE album_id = ? AND song_id = ?`,
          [id, sId]
        );

        if (existRel.length > 0) {
          await pool.query(
            `UPDATE songalbum SET status = 1, is_delete = 0 WHERE id = ?`,
            [existRel[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO songalbum (song_id, album_id, status, is_delete) VALUES (?, ?, 1, 0)`,
            [sId, id]
          );
        }
      }
    }

    res.json({ message: 'Album updated successfully' });
  } catch (error) {
    console.error('Error updating album:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /albums/:id
exports.deleteAlbum = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.body.force === true || req.query.force === 'true';

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    // Check active song relationships in songalbum
    const [dependentSongs] = await pool.query(`
      SELECT s.id, s.name,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') 
              FROM songSinger ss 
              JOIN artists art ON ss.artist_id = art.id 
              WHERE ss.song_id = s.id) as artist
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id
      WHERE sa.album_id = ? AND sa.status = 1 AND sa.is_delete = 0 AND s.status = 1
    `, [id]);

    if (dependentSongs.length > 0 && !force) {
      return res.json({
        hasDependencies: true,
        dependentSongs: dependentSongs.map(s => ({
          id: s.id,
          name: toTitleCase(s.name),
          artist: toTitleCase(s.artist) || 'Unknown Artist'
        }))
      });
    }

    // Soft delete songalbum relationships
    await pool.query(
      `UPDATE songalbum SET status = 0, is_delete = 1 WHERE album_id = ?`,
      [id]
    );

    // Soft delete album
    await pool.query(
      `UPDATE album SET is_delete = 1 WHERE id = ?`,
      [id]
    );

    res.json({ success: true, message: 'Album deleted successfully' });
  } catch (error) {
    console.error('Error deleting album:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /albums/record-labels/dropdown
exports.getRecordLabelDropdown = async (req, res) => {
  try {
    const pool = getPool();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let whereClauses = ['status = 1', 'is_delete = 0'];
    let queryParams = [];

    if (search) {
      whereClauses.push('display_name LIKE ?');
      queryParams.push(`%${search}%`);
    }

    const whereStr = 'WHERE ' + whereClauses.join(' AND ');

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM record_label ${whereStr}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT id, display_name as name FROM record_label ${whereStr} ORDER BY display_name ASC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );

    res.json({
      labels: rows.map(r => ({
        id: r.id,
        name: toTitleCase(r.name)
      })),
      totalCount,
      hasMore: offset + rows.length < totalCount
    });
  } catch (error) {
    console.error('Error fetching record label dropdown:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /albums/songs/dropdown
exports.getSongDropdown = async (req, res) => {
  try {
    const pool = getPool();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let whereClauses = ['status = 1'];
    let queryParams = [];

    if (search) {
      whereClauses.push('name LIKE ?');
      queryParams.push(`%${search}%`);
    }

    const whereStr = 'WHERE ' + whereClauses.join(' AND ');

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM songs ${whereStr}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT id, name FROM songs ${whereStr} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );

    res.json({
      songs: rows.map(s => ({
        id: s.id,
        name: toTitleCase(s.name)
      })),
      totalCount,
      hasMore: offset + rows.length < totalCount
    });
  } catch (error) {
    console.error('Error fetching song dropdown:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /albums/:id
exports.deleteAlbum = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    // Check force flag via query param or body
    const force = (req.query && (req.query.force === 'true' || req.query.force === '1')) || 
                  (req.body && (req.body.force === true || req.body.force === 'true'));

    if (!force) {
      const [activeSongRows] = await pool.query(`
        SELECT s.id, s.name, 
               (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id) as artist
        FROM songalbum sa
        JOIN songs s ON sa.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
        WHERE sa.album_id = ? AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
      `, [id]);

      if (activeSongRows.length > 0) {
        return res.json({
          hasDependencies: true,
          dependentSongs: activeSongRows.map(s => ({
            id: s.id,
            name: toTitleCase(s.name),
            artist: toTitleCase(s.artist) || 'Unknown Artist'
          }))
        });
      }
    }

    // 1. Soft delete album record (is_delete = 1)
    await pool.query(
      `UPDATE album SET is_delete = 1 WHERE id = ?`,
      [id]
    );

    // 2. Soft delete and deactivate related songalbum records (is_delete = 1, status = 0) where is_delete = 0
    await pool.query(
      `UPDATE songalbum SET status = 0, is_delete = 1 WHERE album_id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [id]
    );

    res.json({ success: true, message: 'Album deleted successfully', id });
  } catch (error) {
    console.error('Error deleting album:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
