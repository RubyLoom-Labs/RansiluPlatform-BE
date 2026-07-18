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

// Get all distributors (with server-side pagination, search, ONLY returning active status = 1)
exports.getDistributors = async (req, res) => {
  try {
    const pool = getPool();
    
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';

    // Always enforce d.status = 1 (inactive ones do not come to FE)
    let whereClauses = ['d.status = 1'];
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

    // Fetch records
    let dataQuery = `
      SELECT d.*, COUNT(sd.song_id) as songCount
      FROM distributors d
      LEFT JOIN songdistributor sd ON d.id = sd.distributor_id AND sd.status = 1
      ${whereClauseStr}
      GROUP BY d.id
      ORDER BY d.id DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(dataQuery, [...queryParams, limit, offset]);

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

    // Always fetch where status = 1 (inactive should not be accessed)
    const [rows] = await pool.query('SELECT * FROM distributors WHERE id = ? AND status = 1', [id]);
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

    // Uniqueness validation (ONLY check against active status = 1 records)
    const [existing] = await pool.query(
      'SELECT id, company_name, email FROM distributors WHERE (LOWER(company_name) = ? OR LOWER(email) = ?) AND status = 1',
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
      `INSERT INTO distributors (distributor_code, email, company_name, outgoing_percentage, status) 
       VALUES (?, ?, ?, ?, ?)`,
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

    // Uniqueness validation (excluding current record, ONLY check against active status = 1 records)
    const [existing] = await pool.query(
      'SELECT id, company_name, email FROM distributors WHERE (LOWER(company_name) = ? OR LOWER(email) = ?) AND status = 1 AND id != ?',
      [lowercaseCompany, lowercaseEmail, id]
    );

    if (existing.length > 0) {
      if (existing[0].email.toLowerCase() === lowercaseEmail) {
        return res.status(400).json({ message: 'Email address is already in use by another distributor' });
      }
      return res.status(400).json({ message: 'Company name is already in use by another distributor' });
    }

    const dbStatus = status === 'Active' || status === true || status === 1 || status === '1' ? 1 : 0;

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
