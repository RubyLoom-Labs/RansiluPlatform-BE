const { getPool } = require('../config/db');

// Helper to convert string to Title Case (capitalizing the first letter of each word)
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Function to generate the next sequential distributor code
async function generateDistributorCode(pool) {
  const [rows] = await pool.query(
    "SELECT distributor_code FROM distributors WHERE distributor_code LIKE 'DST%' ORDER BY distributor_code DESC LIMIT 1"
  );
  
  if (rows.length === 0) {
    return 'DST000001';
  }

  const lastCode = rows[0].distributor_code;
  const numPart = lastCode.replace('DST', '');
  const nextNum = parseInt(numPart, 10) + 1;
  return 'DST' + String(nextNum).padStart(6, '0');
}

// Get all distributors (with server-side pagination, search, excluding is_deleted = 1)
exports.getDistributors = async (req, res) => {
  try {
    const pool = getPool();
    
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';
    const isExport = req.query.export === 'true';

    let whereClauses = ['d.is_deleted = 0'];
    let queryParams = [];

    if (search) {
      whereClauses.push('(d.company_name LIKE ? OR d.email LIKE ? OR d.distributor_code LIKE ?)');
      queryParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClauseStr = 'WHERE ' + whereClauses.join(' AND ');

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM distributors d ${whereClauseStr}`,
      queryParams
    );
    const totalCount = countRows[0].total;

    // Fetch records with distinct song count from songdistributor table where status = 1 and is_deleted = 0
    let dataQuery = `
      SELECT d.*, 
             (SELECT COUNT(DISTINCT sd.song_id) 
              FROM songdistributor sd 
              WHERE sd.distributor_id = d.id AND sd.status = 1 AND sd.is_deleted = 0) as songCount
      FROM distributors d
      ${whereClauseStr}
      ORDER BY d.company_name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, queryParams);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [...queryParams, limit, offset]);
    }

    res.json({
      distributors: rows.map(r => ({
        id: r.id,
        distributor_code: r.distributor_code,
        email: r.email,
        company: toTitleCase(r.company_name),
        songCount: r.songCount || 0,
        percentage: r.outgoing_percentage,
        status: r.status === 1 || r.status === true ? 'Active' : 'Inactive',
        notes: '0 notes',
        conflicts: '0 conflicts'
      })),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching distributors:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get single distributor
exports.getDistributorById = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const [rows] = await pool.query('SELECT * FROM distributors WHERE id = ? AND is_deleted = 0', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Distributor not found' });
    }

    const r = rows[0];
    res.json({
      id: r.id,
      distributor_code: r.distributor_code,
      email: r.email,
      company: toTitleCase(r.company_name),
      percentage: r.outgoing_percentage,
      status: r.status === 1 || r.status === true ? 'Active' : 'Inactive'
    });
  } catch (error) {
    console.error('Error fetching distributor by ID:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get distributor songs (paginated, active + inactive, excluding is_deleted = 1)
exports.getDistributorSongs = async (req, res) => {
  try {
    const pool = getPool();
    const distributorId = parseInt(req.params.id, 10);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const isExport = req.query.export === 'true';

    if (isNaN(distributorId)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM songdistributor sd
       JOIN songs s ON sd.song_id = s.id
       WHERE sd.distributor_id = ? AND sd.is_deleted = 0`,
      [distributorId]
    );
    const totalCount = countRows[0].total;

    // Fetch songs, active distributor, and singers/lyricists/musicians
    let dataQuery = `
      SELECT s.id, s.name, sd.updated_date as release_date,
             (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
             (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = s.id) as lyricist,
             (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = s.id) as musician,
             '—' as album,
             s.isrcCode,
             s.versionType,
             s.ownership,
             sd.status as mapping_status
      FROM songdistributor sd
      JOIN songs s ON sd.song_id = s.id
      WHERE sd.distributor_id = ? AND sd.is_deleted = 0
      ORDER BY s.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, [distributorId]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [distributorId, limit, offset]);
    }

    res.json({
      songs: rows.map(s => ({
        id: s.id,
        name: toTitleCase(s.name),
        artist: toTitleCase(s.artist) || 'Unknown Artist',
        lyrics: toTitleCase(s.lyricist) || '—',
        music: toTitleCase(s.musician) || '—',
        album: s.album || '—',
        releaseDate: s.release_date ? (typeof s.release_date === 'object' ? s.release_date.toISOString().split('T')[0] : String(s.release_date).split('T')[0]) : '—',
        isrcCode: s.isrcCode || '—',
        versionType: s.versionType || 'Original',
        ownership: s.ownership || 100,
        status: s.mapping_status === 1 || s.mapping_status === true ? 'Active' : 'Inactive'
      })),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching distributor songs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Create distributor
exports.createDistributor = async (req, res) => {
  try {
    const pool = getPool();
    const { email, company, percentage } = req.body;

    if (!email || !company || percentage === undefined) {
      return res.status(400).json({ message: 'Email, company, and percentage are required fields' });
    }

    const lowercaseEmail = email.trim().toLowerCase();
    const lowercaseCompany = company.trim().toLowerCase();

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(lowercaseEmail)) {
      return res.status(400).json({ message: 'Invalid email address format' });
    }

    // Uniqueness validation (check against non-deleted is_deleted = 0 records)
    const [existing] = await pool.query(
      'SELECT id, company_name, email FROM distributors WHERE (LOWER(company_name) = ? OR LOWER(email) = ?) AND is_deleted = 0',
      [lowercaseCompany, lowercaseEmail]
    );

    if (existing.length > 0) {
      if (existing[0].email.toLowerCase() === lowercaseEmail) {
        return res.status(400).json({ message: 'Email address is already in use by another distributor' });
      }
      return res.status(400).json({ message: 'Company name is already in use by another distributor' });
    }

    const distributor_code = await generateDistributorCode(pool);
    const status = 1;

    const [result] = await pool.query(
      `INSERT INTO distributors (distributor_code, email, company_name, outgoing_percentage, status, is_deleted) 
       VALUES (?, ?, ?, ?, ?, 0)`,
      [distributor_code, lowercaseEmail, lowercaseCompany, parseFloat(percentage), status]
    );

    res.status(201).json({
      id: result.insertId,
      distributor_code,
      email: lowercaseEmail,
      company: toTitleCase(lowercaseCompany),
      percentage: parseFloat(percentage),
      status: 'Active'
    });
  } catch (error) {
    console.error('Error creating distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Update distributor
exports.updateDistributor = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { email, company, percentage, status } = req.body;

    if (!email || !company || percentage === undefined) {
      return res.status(400).json({ message: 'Email, company, and percentage are required fields' });
    }

    const lowercaseEmail = email.trim().toLowerCase();
    const lowercaseCompany = company.trim().toLowerCase();

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(lowercaseEmail)) {
      return res.status(400).json({ message: 'Invalid email address format' });
    }

    // Uniqueness validation (check against non-deleted is_deleted = 0 records)
    const [existing] = await pool.query(
      'SELECT id, company_name, email FROM distributors WHERE (LOWER(company_name) = ? OR LOWER(email) = ?) AND is_deleted = 0 AND id != ?',
      [lowercaseCompany, lowercaseEmail, id]
    );

    if (existing.length > 0) {
      if (existing[0].email.toLowerCase() === lowercaseEmail) {
        return res.status(400).json({ message: 'Email address is already in use by another distributor' });
      }
      return res.status(400).json({ message: 'Company name is already in use by another distributor' });
    }

    const [currentDist] = await pool.query('SELECT status FROM distributors WHERE id = ?', [id]);
    let dbStatus = currentDist.length > 0 ? currentDist[0].status : 1;
    if (status !== undefined) {
      dbStatus = status === 'Active' || status === true || status === 1 || status === '1' ? 1 : 0;
    }

    await pool.query(
      `UPDATE distributors 
       SET email = ?, company_name = ?, outgoing_percentage = ?, status = ? 
       WHERE id = ?`,
      [lowercaseEmail, lowercaseCompany, parseFloat(percentage), dbStatus, id]
    );

    res.json({
      id: parseInt(id, 10),
      email: lowercaseEmail,
      company: toTitleCase(lowercaseCompany),
      percentage: parseFloat(percentage),
      status: dbStatus === 1 ? 'Active' : 'Inactive'
    });
  } catch (error) {
    console.error('Error updating distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Inactivate distributor (soft inactivates related song mappings)
exports.inactivateDistributor = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.query.force === 'true' || req.body.force === true;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    // Check active song relationships
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songdistributor sd
       JOIN songs s ON sd.song_id = s.id
       WHERE sd.distributor_id = ? AND sd.status = 1 AND sd.is_deleted = 0 AND s.status = 1`,
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

    // Set distributor status = 0
    await pool.query('UPDATE distributors SET status = 0 WHERE id = ?', [id]);
    // Set all related songdistributor mapping status = 0
    await pool.query('UPDATE songdistributor SET status = 0 WHERE distributor_id = ?', [id]);

    res.json({
      success: true,
      hasDependencies: false
    });
  } catch (error) {
    console.error('Error inactivating distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Delete distributor (soft delete by setting is_deleted = 1)
exports.deleteDistributor = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    // Update distributors table to set is_deleted = 1
    await pool.query('UPDATE distributors SET is_deleted = 1 WHERE id = ?', [id]);
    // Update related songdistributor table to set is_deleted = 1
    await pool.query('UPDATE songdistributor SET is_deleted = 1 WHERE distributor_id = ?', [id]);

    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error deleting distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
