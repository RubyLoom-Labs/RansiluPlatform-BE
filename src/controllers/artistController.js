const { getPool } = require('../config/db');
const fs = require('fs');
const path = require('path');

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

// Get all artists
exports.getArtists = async (req, res) => {
  try {
    const pool = getPool();
    const [artists] = await pool.query(`
      SELECT a.*, COUNT(sa.song_id) as songsCount 
      FROM artists a 
      LEFT JOIN song_artists sa ON a.id = sa.artist_id AND sa.role = 'singer'
      GROUP BY a.id 
      ORDER BY a.id DESC
    `);

    const host = `${req.protocol}://${req.get('host')}`;
    const formattedArtists = artists.map((artist) => {
      // Synthesize types array from individual boolean columns for UI compatibility
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
        gender: artist.gender, // 'M' or 'F'
        types, // tags representation
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

    res.json(formattedArtists);
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
      [name, artistCode, gender, music, lyrics, singer, band, other, imagePath, status]
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
      name,
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
        [name, genderValue, music, lyrics, singer, band, other, imagePath, status, id]
      );
    } else {
      await pool.query(
        `UPDATE artists 
         SET name = ?, gender = ?, music = ?, lyrics = ?, singer = ?, band = ?, other = ?, status = ?
         WHERE id = ?`,
        [name, genderValue, music, lyrics, singer, band, other, status, id]
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
