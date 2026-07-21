const { getPool } = require('../config/db');

// Helper function to format strings to Title Case
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Convert input name to simple letters format (lowercase, no spaces, no special characters)
function toSimpleLetters(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// GET /record-label & GET /record-label/search
exports.getRecordLabels = async (req, res) => {
  try {
    const pool = getPool();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || req.query.keyword || '';
    const isExport = req.query.export === 'true';

    let whereClauses = ['rl.is_delete = 0'];
    let queryParams = [];

    if (search.trim()) {
      whereClauses.push('(rl.name LIKE ? OR rl.display_name LIKE ?)');
      const simpleQ = toSimpleLetters(search);
      queryParams.push(`%${search.trim()}%`, `%${simpleQ}%`);
    }

    const whereClauseStr = `WHERE ${whereClauses.join(' AND ')}`;

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM record_label rl ${whereClauseStr}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    // Data query with song count
    let dataQuery = `
      SELECT rl.*,
             (SELECT COUNT(DISTINCT srl.song_id)
              FROM songrecordlabel srl
              JOIN songs s ON srl.song_id = s.id
              WHERE srl.record_label_id = rl.id AND srl.status = 1 AND srl.is_delete = 0 AND s.status = 1) as songCount
      FROM record_label rl
      ${whereClauseStr}
      ORDER BY rl.display_name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, queryParams);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [...queryParams, limit, offset]);
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const formattedList = rows.map(r => {
      const img = r.image_url ? (r.image_url.startsWith('http') || r.image_url.startsWith('data:') ? r.image_url : `${host}${r.image_url}`) : null;
      return {
        id: r.id,
        name: r.display_name || toTitleCase(r.name),
        rawName: r.name,
        imageUrl: img,
        image_url: img,
        logo: img,
        status: r.status === 1 || r.status === true ? 'Active' : 'Inactive',
        statusCode: r.status,
        songCount: r.songCount || 0,
        created_at: r.created_at
      };
    });

    res.json({
      data: formattedList,
      labels: formattedList,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      totalRecords: totalCount,
      totalCount
    });
  } catch (error) {
    console.error('Error fetching record labels:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /record-label/search
exports.searchRecordLabels = async (req, res) => {
  return exports.getRecordLabels(req, res);
};

// GET /record-label/export
exports.exportRecordLabels = async (req, res) => {
  req.query.export = 'true';
  return exports.getRecordLabels(req, res);
};

// GET /record-label/:id
exports.getRecordLabelById = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record label ID' });
    }

    const [rows] = await pool.query(
      `SELECT rl.*,
              (SELECT COUNT(DISTINCT srl.song_id)
               FROM songrecordlabel srl
               JOIN songs s ON srl.song_id = s.id
               WHERE srl.record_label_id = rl.id AND srl.status = 1 AND srl.is_delete = 0 AND s.status = 1) as songCount
       FROM record_label rl
       WHERE rl.id = ? AND rl.is_delete = 0`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Record label not found' });
    }

    const r = rows[0];
    const host = `${req.protocol}://${req.get('host')}`;
    const img = r.image_url ? (r.image_url.startsWith('http') || r.image_url.startsWith('data:') ? r.image_url : `${host}${r.image_url}`) : null;

    res.json({
      id: r.id,
      name: r.display_name || toTitleCase(r.name),
      rawName: r.name,
      imageUrl: img,
      image_url: img,
      logo: img,
      status: r.status === 1 || r.status === true ? 'Active' : 'Inactive',
      statusCode: r.status,
      songCount: r.songCount || 0,
      created_at: r.created_at
    });
  } catch (error) {
    console.error('Error fetching record label details:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /record-label/:id/songs
exports.getRecordLabelSongs = async (req, res) => {
  try {
    const pool = getPool();
    const labelId = parseInt(req.params.id, 10);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    if (isNaN(labelId)) {
      return res.status(400).json({ message: 'Invalid record label ID' });
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM songrecordlabel srl
       JOIN songs s ON srl.song_id = s.id
       WHERE srl.record_label_id = ? AND srl.status = 1 AND srl.is_delete = 0 AND s.status = 1`,
      [labelId]
    );
    const totalCount = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT s.id, s.name, srl.created_at as release_date,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = s.id) as lyricist,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = s.id) as musician,
              s.isrcCode,
              s.versionType,
              s.ownership
       FROM songrecordlabel srl
       JOIN songs s ON srl.song_id = s.id
       WHERE srl.record_label_id = ? AND srl.status = 1 AND srl.is_delete = 0 AND s.status = 1
       ORDER BY s.name ASC
       LIMIT ? OFFSET ?`,
      [labelId, limit, offset]
    );

    res.json({
      songs: rows.map(s => ({
        id: s.id,
        name: toTitleCase(s.name),
        artist: toTitleCase(s.artist) || 'Unknown Artist',
        lyrics: toTitleCase(s.lyricist) || '—',
        music: toTitleCase(s.musician) || '—',
        album: '—',
        releaseDate: s.release_date ? String(s.release_date).split('T')[0] : '—',
        isrcCode: s.isrcCode || '—',
        versionType: s.versionType || 'Original',
        ownership: s.ownership || 100,
        status: 'Active'
      })),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching record label songs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /record-label
exports.createRecordLabel = async (req, res) => {
  try {
    const pool = getPool();
    const { name, image_url } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Record label name is required' });
    }

    const convertedName = toSimpleLetters(name);
    const displayName = name.trim();

    if (!convertedName) {
      return res.status(400).json({ message: 'Invalid record label name format' });
    }

    // Check duplicate name against non-deleted records
    const [existing] = await pool.query(
      `SELECT id FROM record_label WHERE name = ? AND is_delete = 0`,
      [convertedName]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Record label name already exists' });
    }

    const [result] = await pool.query(
      `INSERT INTO record_label (name, display_name, image_url, status, is_delete)
       VALUES (?, ?, ?, 1, 0)`,
      [convertedName, displayName, image_url || null]
    );

    const host = `${req.protocol}://${req.get('host')}`;
    const img = image_url ? (image_url.startsWith('http') || image_url.startsWith('data:') ? image_url : `${host}${image_url}`) : null;

    res.status(201).json({
      message: 'Record label created successfully',
      id: result.insertId,
      recordLabel: {
        id: result.insertId,
        name: displayName,
        rawName: convertedName,
        imageUrl: img,
        image_url: img,
        logo: img,
        status: 'Active',
        statusCode: 1,
        songCount: 0
      }
    });
  } catch (error) {
    console.error('Error creating record label:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /record-label/:id
exports.updateRecordLabel = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const { name, image_url } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record label ID' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Record label name is required' });
    }

    const convertedName = toSimpleLetters(name);
    const displayName = name.trim();

    // Check duplicate name against non-deleted records excluding current id
    const [existing] = await pool.query(
      `SELECT id FROM record_label WHERE name = ? AND is_delete = 0 AND id != ?`,
      [convertedName, id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Record label name already exists' });
    }

    await pool.query(
      `UPDATE record_label 
       SET name = ?, display_name = ?, image_url = COALESCE(?, image_url)
       WHERE id = ? AND is_delete = 0`,
      [convertedName, displayName, image_url || null, id]
    );

    res.json({ message: 'Record label updated successfully' });
  } catch (error) {
    console.error('Error updating record label:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /record-label/:id/inactivate & PATCH /record-label/:id/status
exports.inactivateRecordLabel = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.body.force === true || req.query.force === 'true';

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record label ID' });
    }

    // Check active song relationships in songrecordlabel
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songrecordlabel srl
       JOIN songs s ON srl.song_id = s.id
       WHERE srl.record_label_id = ? AND srl.status = 1 AND srl.is_delete = 0`,
      [id]
    );

    if (dependencies.length > 0 && !force) {
      return res.json({
        success: false,
        hasDependencies: true,
        dependentSongs: dependencies.map(row => ({
          id: row.id,
          name: toTitleCase(row.name),
          artist: toTitleCase(row.artist) || 'Unknown Artist',
          album: '—'
        }))
      });
    }

    // Deactivate record_label
    await pool.query('UPDATE record_label SET status = 0 WHERE id = ?', [id]);
    // Deactivate related active song relationships
    await pool.query('UPDATE songrecordlabel SET status = 0 WHERE record_label_id = ? AND status = 1 AND is_delete = 0', [id]);

    res.json({
      success: true,
      hasDependencies: false,
      message: 'Record label deactivated successfully'
    });
  } catch (error) {
    console.error('Error inactivating record label:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /record-label/:id/activate
exports.activateRecordLabel = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record label ID' });
    }

    // Reactivate record_label
    await pool.query('UPDATE record_label SET status = 1, is_delete = 0 WHERE id = ?', [id]);
    // Reactivate related songrecordlabel relationships if needed
    await pool.query('UPDATE songrecordlabel SET status = 1 WHERE record_label_id = ? AND is_delete = 0', [id]);

    res.json({
      success: true,
      message: 'Record label reactivated successfully'
    });
  } catch (error) {
    console.error('Error activating record label:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /record-label/:id
exports.deleteRecordLabel = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.body.force === true || req.query.force === 'true';

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record label ID' });
    }

    // Check status
    const [labelRows] = await pool.query('SELECT status FROM record_label WHERE id = ? AND is_delete = 0', [id]);
    if (labelRows.length === 0) {
      return res.status(404).json({ message: 'Record label not found' });
    }

    if (labelRows[0].status === 1) {
      return res.status(400).json({ message: 'Active record labels cannot be deleted. Please inactivate first.' });
    }

    // Check related songs in songrecordlabel
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songrecordlabel srl
       JOIN songs s ON srl.song_id = s.id
       WHERE srl.record_label_id = ? AND srl.is_delete = 0`,
      [id]
    );

    if (dependencies.length > 0 && !force) {
      return res.json({
        success: false,
        hasDependencies: true,
        dependentSongs: dependencies.map(row => ({
          id: row.id,
          name: toTitleCase(row.name),
          artist: toTitleCase(row.artist) || 'Unknown Artist',
          album: '—'
        }))
      });
    }

    // Soft delete
    await pool.query('UPDATE record_label SET is_delete = 1 WHERE id = ?', [id]);
    await pool.query('UPDATE songrecordlabel SET is_delete = 1 WHERE record_label_id = ?', [id]);

    res.json({
      success: true,
      hasDependencies: false,
      message: 'Record label deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting record label:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
