const { getPool } = require('../config/db');
const fs = require('fs');
const path = require('path');

// Helper to convert artist name to simple English letters (lowercase, a-z, and single spaces only)
function toSimpleName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Function to generate the next sequential artist code
async function generateArtistCode(pool) {
  const [rows] = await pool.query(
    "SELECT artist_code FROM artists WHERE artist_code LIKE 'ART%' ORDER BY artist_code DESC LIMIT 1"
  );
  
  if (rows.length === 0) {
    return 'ART000001';
  }

  const lastCode = rows[0].artist_code;
  const numPart = lastCode.replace('ART', '');
  const nextNum = parseInt(numPart, 10) + 1;
  return 'ART' + String(nextNum).padStart(6, '0');
}

// Get all artists (with server-side pagination, filtering, and sorting)
exports.getArtists = async (req, res) => {
  try {
    const pool = getPool();
    
    // Parse query parameters
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';
    const role = req.query.role || '';
    const gender = req.query.gender || '';
    const sort = req.query.sort || '';
    const isExport = req.query.export === 'true';

    // Build WHERE clause
    let whereClauses = [];
    let queryParams = [];

    if (search) {
      whereClauses.push('(a.name LIKE ? OR a.artist_code LIKE ?)');
      queryParams.push(`%${search}%`, `%${search}%`);
    }

    if (role) {
      if (role.toLowerCase() === 'artist') {
        whereClauses.push('(a.singer = 1 OR a.band = 1)');
      } else if (['music', 'lyrics', 'singer', 'band', 'other'].includes(role.toLowerCase())) {
        whereClauses.push(`a.${role.toLowerCase()} = 1`);
      }
    }

    // Dropdown fields select active artists only
    if (role) {
      whereClauses.push('a.status = 1');
    }

    if (gender) {
      let dbGender = '';
      if (gender === 'Male' || gender === 'M') dbGender = 'M';
      else if (gender === 'Female' || gender === 'F') dbGender = 'F';
      else if (gender === 'Other/Band' || gender === 'Other/Group' || gender === 'O' || gender === 'Other') dbGender = 'O';
      
      if (dbGender) {
        whereClauses.push('a.gender = ?');
        queryParams.push(dbGender);
      }
    }

    const whereClauseStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Get total count of matching records
    const countQuery = `
      SELECT COUNT(DISTINCT a.id) as total 
      FROM artists a
      ${whereClauseStr}
    `;
    const [countRows] = await pool.query(countQuery, queryParams);
    const totalCount = countRows[0].total;

    // Determine sorting order
    let orderBy = 'ORDER BY a.id DESC';
    if (sort === 'Songs A-Z' || sort === 'Artists A-Z') {
      orderBy = 'ORDER BY a.name ASC';
    }
    
    // Sort by artist code if no filter is added during export
    if (isExport && !search && !role && !gender) {
      orderBy = 'ORDER BY a.artist_code ASC';
    }

    // Default to sorting by artist code for dropdown listings (when role is set but sort parameter is omitted)
    if (!sort && role) {
      orderBy = 'ORDER BY a.artist_code ASC';
    }

    // Fetch paginated and filtered records
    let dataQuery = `
      SELECT a.*, COUNT(ss.song_id) as songsCount 
      FROM artists a 
      LEFT JOIN songSinger ss ON a.id = ss.artist_id
      ${whereClauseStr}
      GROUP BY a.id 
      ${orderBy}
    `;
    
    let queryParamsForData = [...queryParams];
    if (!isExport) {
      dataQuery += ' LIMIT ? OFFSET ?';
      queryParamsForData.push(limit, offset);
    }
    
    const [artists] = await pool.query(dataQuery, queryParamsForData);

    const host = `${req.protocol}://${req.get('host')}`;
    const formattedArtists = artists.map((artist) => {
      const types = [];
      if (artist.music) types.push('music');
      if (artist.lyrics) types.push('lyrics');
      if (artist.singer) types.push('singer');
      if (artist.band) types.push('band');
      if (artist.other) types.push('other');

      return {
        id: artist.id,
        name: artist.name,
        code: artist.artist_code,
        artist_code: artist.artist_code,
        gender: artist.gender,
        types,
        music: artist.music === 1 || artist.music === true,
        lyrics: artist.lyrics === 1 || artist.lyrics === true,
        singer: artist.singer === 1 || artist.singer === true,
        band: artist.band === 1 || artist.band === true,
        other: artist.other === 1 || artist.other === true,
        status: artist.status === 1 || artist.status === true,
        songsCount: artist.songsCount || 0,
        avatar: artist.image 
          ? (artist.image.startsWith('http') ? artist.image : `${host}${artist.image}`) 
          : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200&h=200',
        imageUrl: artist.image 
          ? (artist.image.startsWith('http') ? artist.image : `${host}${artist.image}`) 
          : null,
      };
    });

    res.json({
      artists: formattedArtists,
      totalCount
    });
  } catch (error) {
    console.error('Error fetching artists:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Create new artist
exports.createArtist = async (req, res) => {
  try {
    const pool = getPool();
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const simpleName = toSimpleName(name);
    if (!simpleName) {
      return res.status(400).json({ message: 'Name must contain English letters' });
    }

    const parseBool = (val) => {
      if (val === undefined || val === null) return false;
      return val === true || val === 'true' || val === '1' || val === 1;
    };

    // Normalize inputs
    const gender = req.body.gender === 'Female' || req.body.gender === 'F' ? 'F' : (req.body.gender === 'Other/Band' || req.body.gender === 'Other/Group' || req.body.gender === 'O' ? 'O' : 'M');
    let music = parseBool(req.body.music);
    let lyrics = parseBool(req.body.lyrics);
    let singer = parseBool(req.body.singer);
    let band = parseBool(req.body.band);
    let other = parseBool(req.body.other);
    const status = req.body.status !== undefined ? parseBool(req.body.status) : true;

    // Fallback checks for dynamic roles array from frontend
    let types = req.body.types || [];
    if (!Array.isArray(types)) {
      types = [types];
    }
    if (types.includes('music')) music = true;
    if (types.includes('lyrics')) lyrics = true;
    if (types.includes('singer')) singer = true;
    if (types.includes('band')) band = true;
    if (types.includes('other')) other = true;

    // Generate sequential unique artist code
    const artistCode = await generateArtistCode(pool);

    // Handle uploaded file path
    let imagePath = null;
    if (req.file) {
      imagePath = `/uploads/images/${req.file.filename}`;
    }

    const [result] = await pool.query(
      `INSERT INTO artists (name, artist_code, gender, music, lyrics, singer, band, other, image, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [simpleName, artistCode, gender, music, lyrics, singer, band, other, imagePath, status]
    );

    const host = `${req.protocol}://${req.get('host')}`;
    const newArtistId = result.insertId;

    // Re-synthesize types array for frontend response
    const responseTypes = [];
    if (music) responseTypes.push('music');
    if (lyrics) responseTypes.push('lyrics');
    if (singer) responseTypes.push('singer');
    if (band) responseTypes.push('band');
    if (other) responseTypes.push('other');

    res.status(201).json({
      id: newArtistId,
      name: simpleName,
      code: artistCode,
      artist_code: artistCode,
      gender,
      types: responseTypes,
      music,
      lyrics,
      singer,
      band,
      other,
      status,
      songsCount: 0,
      avatar: imagePath ? `${host}${imagePath}` : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200&h=200',
      imageUrl: imagePath ? `${host}${imagePath}` : null,
    });
  } catch (error) {
    console.error('Error creating artist:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Update artist details
exports.updateArtist = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { name, gender } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const simpleName = toSimpleName(name);
    if (!simpleName) {
      return res.status(400).json({ message: 'Name must contain English letters' });
    }

    const parseBool = (val) => {
      if (val === undefined || val === null) return false;
      return val === true || val === 'true' || val === '1' || val === 1;
    };

    // Normalize inputs
    const genderValue = gender === 'Female' || gender === 'F' ? 'F' : (gender === 'Other/Band' || gender === 'Other/Group' || gender === 'O' ? 'O' : 'M');
    let music = parseBool(req.body.music);
    let lyrics = parseBool(req.body.lyrics);
    let singer = parseBool(req.body.singer);
    let band = parseBool(req.body.band);
    let other = parseBool(req.body.other);
    const status = req.body.status !== undefined ? parseBool(req.body.status) : true;

    // Fallback checks for types array
    let types = req.body.types || [];
    if (!Array.isArray(types)) {
      types = [types];
    }
    if (types.includes('music')) music = true;
    if (types.includes('lyrics')) lyrics = true;
    if (types.includes('singer')) singer = true;
    if (types.includes('band')) band = true;
    if (types.includes('other')) other = true;

    // Retrieve existing artist to find old image path
    const [currentArtistRows] = await pool.query('SELECT image FROM artists WHERE id = ?', [id]);
    const currentArtist = currentArtistRows[0];

    // Optional: handle uploaded file for editing
    let imagePath = null;
    if (req.file) {
      imagePath = `/uploads/images/${req.file.filename}`;
      
      // Delete the previous image file from backend store
      if (currentArtist && currentArtist.image) {
        const oldFilePath = path.join(process.cwd(), currentArtist.image);
        fs.unlink(oldFilePath, (err) => {
          if (err) {
            console.warn('Failed to delete old image file:', err);
          } else {
            console.log('Successfully deleted old image file:', oldFilePath);
          }
        });
      }
    }

    if (imagePath) {
      await pool.query(
        `UPDATE artists 
         SET name = ?, gender = ?, music = ?, lyrics = ?, singer = ?, band = ?, other = ?, image = ?, status = ?
         WHERE id = ?`,
        [simpleName, genderValue, music, lyrics, singer, band, other, imagePath, status, id]
      );
    } else {
      await pool.query(
        `UPDATE artists 
         SET name = ?, gender = ?, music = ?, lyrics = ?, singer = ?, band = ?, other = ?, status = ?
         WHERE id = ?`,
        [simpleName, genderValue, music, lyrics, singer, band, other, status, id]
      );
    }

    // Retrieve updated artist
    const [rows] = await pool.query('SELECT * FROM artists WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Artist not found' });
    }

    const updatedArtist = rows[0];
    const responseTypes = [];
    if (updatedArtist.music) responseTypes.push('music');
    if (updatedArtist.lyrics) responseTypes.push('lyrics');
    if (updatedArtist.singer) responseTypes.push('singer');
    if (updatedArtist.band) responseTypes.push('band');
    if (updatedArtist.other) responseTypes.push('other');

    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      id: updatedArtist.id,
      name: updatedArtist.name,
      code: updatedArtist.artist_code,
      artist_code: updatedArtist.artist_code,
      gender: updatedArtist.gender,
      types: responseTypes,
      music: !!updatedArtist.music,
      lyrics: !!updatedArtist.lyrics,
      singer: !!updatedArtist.singer,
      band: !!updatedArtist.band,
      other: !!updatedArtist.other,
      status: !!updatedArtist.status,
      avatar: updatedArtist.image ? `${host}${updatedArtist.image}` : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200&h=200',
      imageUrl: updatedArtist.image ? `${host}${updatedArtist.image}` : null,
    });
  } catch (error) {
    console.error('Error updating artist:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Check if artist name exists in simple form
exports.checkArtistName = async (req, res) => {
  try {
    const pool = getPool();
    const { name, id } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const simpleInput = toSimpleName(name);

    let query = 'SELECT id, name FROM artists';
    let queryParams = [];
    if (id) {
      query += ' WHERE id != ?';
      queryParams.push(id);
    }

    const [rows] = await pool.query(query, queryParams);

    const exists = rows.some((row) => toSimpleName(row.name) === simpleInput);

    res.json({ exists });
  } catch (error) {
    console.error('Error checking artist name:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get a single artist by ID
exports.getArtistById = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);
    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    const [rows] = await pool.query('SELECT * FROM artists WHERE id = ?', [artistId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Artist not found' });
    }

    const artist = rows[0];
    const types = [];
    if (artist.music) types.push('music');
    if (artist.lyrics) types.push('lyrics');
    if (artist.singer) types.push('singer');
    if (artist.band) types.push('band');
    if (artist.other) types.push('other');

    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      id: artist.id,
      name: artist.name,
      code: artist.artist_code,
      artist_code: artist.artist_code,
      gender: artist.gender,
      types,
      music: artist.music === 1 || artist.music === true,
      lyrics: artist.lyrics === 1 || artist.lyrics === true,
      singer: artist.singer === 1 || artist.singer === true,
      band: artist.band === 1 || artist.band === true,
      other: artist.other === 1 || artist.other === true,
      status: artist.status === 1 || artist.status === true,
      avatar: artist.image 
        ? (artist.image.startsWith('http') ? artist.image : `${host}${artist.image}`) 
        : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200&h=200',
      imageUrl: artist.image 
        ? (artist.image.startsWith('http') ? artist.image : `${host}${artist.image}`) 
        : null,
    });
  } catch (error) {
    console.error('Error fetching artist by ID:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
