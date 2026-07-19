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

// Get all active ringtone operators
exports.getRingtones = async (req, res) => {
  try {
    const pool = getPool();

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const isExport = req.query.export === 'true';

    const search = req.query.search || '';

    // Enforce status = 1 filter
    let whereClauses = ['r.status = 1'];
    let queryParams = [];

    if (search) {
      whereClauses.push('r.name LIKE ?');
      queryParams.push(`%${search}%`);
    }

    const whereClauseStr = 'WHERE ' + whereClauses.join(' AND ');

    // Count
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM ringintone r ${whereClauseStr}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    // Fetch records (Distinct song count)
    let dataQuery = `
      SELECT r.*, COUNT(DISTINCT sr.song_id) as songCount
      FROM ringintone r
      LEFT JOIN songringintone sr ON r.id = sr.ringintone_id AND sr.status = 1
      ${whereClauseStr}
      GROUP BY r.id
      ORDER BY r.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, queryParams);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [...queryParams, limit, offset]);
    }

    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      ringtones: rows.map(r => ({
        id: r.id,
        name: toTitleCase(r.name),
        shortName: toTitleCase(r.name).split(' ')[0],
        logo: r.company_logo ? (r.company_logo.startsWith('http') ? r.company_logo : `${host}${r.company_logo}`) : null,
        status: 'Active',
        songCount: r.songCount || 0
      })),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching ringtones:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get single active ringtone operator
exports.getRingtoneById = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const [rows] = await pool.query('SELECT * FROM ringintone WHERE id = ? AND status = 1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Operator not found' });
    }

    const r = rows[0];
    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      id: r.id,
      name: toTitleCase(r.name),
      shortName: toTitleCase(r.name).split(' ')[0],
      logo: r.company_logo ? (r.company_logo.startsWith('http') ? r.company_logo : `${host}${r.company_logo}`) : null,
      status: 'Active'
    });
  } catch (error) {
    console.error('Error fetching ringtone by ID:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Create ringtone operator
exports.createRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Operator name is required.' });
    }

    const lowercaseName = name.trim().toLowerCase();

    // Check if name is unique
    const [existing] = await pool.query('SELECT id FROM ringintone WHERE LOWER(name) = ?', [lowercaseName]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Ringtone account with this name already exists.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Operator logo file is required.' });
    }

    const company_logo = `/uploads/images/${req.file.filename}`;

    const status = 1; // Default Active (true)

    const [result] = await pool.query(
      `INSERT INTO ringintone (name, company_logo, status) 
       VALUES (?, ?, ?)`,
      [lowercaseName, company_logo, status]
    );

    const host = `${req.protocol}://${req.get('host')}`;

    res.status(201).json({
      id: result.insertId,
      name: toTitleCase(lowercaseName),
      shortName: toTitleCase(lowercaseName).split(' ')[0],
      logo: company_logo ? `${host}${company_logo}` : null,
      status: 'Active'
    });
  } catch (error) {
    console.error('Error creating ringtone operator:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Update ringtone operator
exports.updateRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { name, status } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Operator name is required.' });
    }

    const [existing] = await pool.query('SELECT * FROM ringintone WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Operator not found' });
    }

    const lowercaseName = name.trim().toLowerCase();

    // Check if name is unique
    const [duplicate] = await pool.query('SELECT id FROM ringintone WHERE LOWER(name) = ? AND id != ?', [lowercaseName, id]);
    if (duplicate.length > 0) {
      return res.status(400).json({ message: 'Ringtone account with this name already exists.' });
    }

    let company_logo = existing[0].company_logo;
    if (req.file) {
      company_logo = `/uploads/images/${req.file.filename}`;
    }

    let dbStatus = existing[0].status;
    if (status !== undefined) {
      dbStatus = status === 'Active' || status === true || status === 1 || status === '1' ? 1 : 0;
    }

    await pool.query(
      `UPDATE ringintone 
       SET name = ?, company_logo = ?, status = ? 
       WHERE id = ?`,
      [lowercaseName, company_logo, dbStatus, id]
    );

    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      id: parseInt(id, 10),
      name: toTitleCase(lowercaseName),
      shortName: toTitleCase(lowercaseName).split(' ')[0],
      logo: company_logo ? (company_logo.startsWith('http') ? company_logo : `${host}${company_logo}`) : null,
      status: dbStatus === 1 ? 'Active' : 'Inactive'
    });
  } catch (error) {
    console.error('Error updating ringtone operator:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Delete ringtone operator with dependencies check
exports.deleteRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.query.force === 'true' || req.body.force === true;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid operator ID' });
    }

    // Check active SongRingtone dependencies
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name, 
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songringintone sr
       JOIN songs s ON sr.song_id = s.id
       WHERE sr.ringintone_id = ? AND sr.status = 1 AND s.status = 1`,
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

    // Soft delete ringtone operator
    await pool.query('UPDATE ringintone SET status = 0 WHERE id = ?', [id]);

    // Soft delete song relationships
    await pool.query('UPDATE songringintone SET status = 0 WHERE ringintone_id = ?', [id]);

    res.json({
      success: true,
      hasDependencies: false
    });
  } catch (error) {
    console.error('Error deleting ringtone:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get songs mapping to selected ringtone
exports.getRingtoneSongs = async (req, res) => {
  try {
    const pool = getPool();
    const ringtoneId = parseInt(req.params.id, 10);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const isExport = req.query.export === 'true';

    if (isNaN(ringtoneId)) {
      return res.status(400).json({ message: 'Invalid operator ID' });
    }

    // Check total count of active songs mapping to this ringtone
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM songringintone sr
       JOIN songs s ON sr.song_id = s.id
       WHERE sr.ringintone_id = ? AND sr.status = 1 AND s.status = 1`,
      [ringtoneId]
    );
    const totalCount = countRows[0].total;

    // Fetch songs, active distributor, and distinct singers, lyricists, musicians
    let dataQuery = `
      SELECT s.id, s.name, sr.added_date as release_date,
             (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
             (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = s.id) as lyricist,
             (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = s.id) as musician,
             '—' as album,
             dist.company_name as distributor,
             s.isrcCode,
             s.versionType,
             s.ownership
      FROM songringintone sr
      JOIN songs s ON sr.song_id = s.id
      LEFT JOIN songdistributor sd ON s.id = sd.song_id AND sd.status = 1
      LEFT JOIN distributors dist ON sd.distributor_id = dist.id
      WHERE sr.ringintone_id = ? AND sr.status = 1 AND s.status = 1
      ORDER BY s.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, [ringtoneId]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [ringtoneId, limit, offset]);
    }

    res.json({
      songs: rows.map(s => ({
        id: s.id,
        name: toTitleCase(s.name),
        artist: toTitleCase(s.artist) || 'Unknown Artist',
        lyrics: toTitleCase(s.lyricist) || '—',
        music: toTitleCase(s.musician) || '—',
        album: s.album || '—',
        distributor: toTitleCase(s.distributor) || '—',
        releaseDate: s.release_date ? (typeof s.release_date === 'object' ? s.release_date.toISOString().split('T')[0] : String(s.release_date).split('T')[0]) : '—',
        isrcCode: s.isrcCode || '—',
        versionType: s.versionType || 'Original',
        ownership: s.ownership || 100
      })),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching ringtone songs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

