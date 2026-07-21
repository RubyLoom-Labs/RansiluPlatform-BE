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
  if (!img) return null;
  if (img.startsWith('http') || img.startsWith('data:')) return img;
  return `${host}${img}`;
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

// GET /albums/:id
exports.getAlbumById = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    const [rows] = await pool.query(`
      SELECT a.*, rl.display_name as labelName
      FROM album a
      LEFT JOIN record_label rl ON a.record_label_id = rl.id AND rl.is_delete = 0
      WHERE a.id = ? AND a.is_delete = 0
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Album not found' });
    }

    const r = rows[0];
    const host = `${req.protocol}://${req.get('host')}`;
    const img = formatImage(r.image_url, host);

    // Fetch related songs
    const [songRows] = await pool.query(`
      SELECT s.id, s.name, s.imageUrl, s.duration, s.isrcCode, s.versionType,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') 
              FROM songSinger ss 
              JOIN artists art ON ss.artist_id = art.id 
              WHERE ss.song_id = s.id) as artist
      FROM songalbum sa
      JOIN songs s ON sa.song_id = s.id
      WHERE sa.album_id = ? AND sa.status = 1 AND sa.is_delete = 0 AND s.status = 1
      ORDER BY s.name ASC
    `, [id]);

    const formattedSongs = songRows.map(s => ({
      id: s.id,
      name: toTitleCase(s.name),
      artist: toTitleCase(s.artist) || 'Unknown Artist',
      imageUrl: formatImage(s.imageUrl, host),
      duration: s.duration || '03:45',
      isrcCode: s.isrcCode || '—',
      versionType: s.versionType || 'Original'
    }));

    res.json({
      id: r.id,
      name: r.display_name || toTitleCase(r.name),
      rawName: r.name,
      imageUrl: img,
      image_url: img,
      recordLabelId: r.record_label_id,
      recordLabelName: r.labelName || '—',
      songCount: formattedSongs.length,
      created_at: r.created_at,
      updated_at: r.updated_at,
      songs: formattedSongs
    });
  } catch (error) {
    console.error('Error fetching album details:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /albums
exports.createAlbum = async (req, res) => {
  try {
    const pool = getPool();
    const { name, image_url, record_label_id, song_ids } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Album name is required' });
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
      `INSERT INTO album (name, display_name, image_url, record_label_id, is_delete)
       VALUES (?, ?, ?, ?, 0)`,
      [convertedName, displayName, image_url || null, labelId]
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
    const { name, image_url, record_label_id, song_ids } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid album ID' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Album name is required' });
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
       SET name = ?, display_name = ?, image_url = ?, record_label_id = ?
       WHERE id = ? AND is_delete = 0`,
      [convertedName, displayName, image_url || null, labelId, id]
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
