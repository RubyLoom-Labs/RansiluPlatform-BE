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

// Get all ringtone operators
exports.getRingtones = async (req, res) => {
  try {
    const pool = getPool();

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const search = req.query.search || '';
    const status = req.query.status;

    let whereClauses = [];
    let queryParams = [];

    if (search) {
      whereClauses.push('r.name LIKE ?');
      queryParams.push(`%${search}%`);
    }

    if (status !== undefined) {
      whereClauses.push('r.status = ?');
      const isStatusActive = 
        status === 'true' || 
        status === true || 
        String(status).toLowerCase() === 'active' || 
        String(status) === '1';
      queryParams.push(isStatusActive ? 1 : 0);
    }

    const whereClauseStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Count
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM ringintone r ${whereClauseStr}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    // Fetch records
    let dataQuery = `
      SELECT r.*, COUNT(sr.song_id) as songCount
      FROM ringintone r
      LEFT JOIN songringintone sr ON r.id = sr.ringintone_id AND sr.status = 1
      ${whereClauseStr}
      GROUP BY r.id
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(dataQuery, [...queryParams, limit, offset]);

    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      ringtones: rows.map(r => ({
        id: r.id,
        name: toTitleCase(r.name),
        shortName: toTitleCase(r.name).split(' ')[0],
        logo: r.company_logo ? (r.company_logo.startsWith('http') ? r.company_logo : `${host}${r.company_logo}`) : null,
        status: r.status === 1 || r.status === true ? 'Active' : 'Inactive',
        songCount: r.songCount || 0
      })),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching ringtones:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get single ringtone operator
exports.getRingtoneById = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const [rows] = await pool.query('SELECT * FROM ringintone WHERE id = ?', [id]);
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
      status: r.status === 1 || r.status === true ? 'Active' : 'Inactive'
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

    const dbStatus = status === 'Active' || status === true || status === 1 || status === '1' ? 1 : 0;

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
