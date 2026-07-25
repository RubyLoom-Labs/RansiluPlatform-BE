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
    let whereClauses = ['(a.is_delete = 0 OR a.is_delete IS NULL)'];
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
      SELECT a.*, 
        (
          SELECT COUNT(DISTINCT rel.song_id)
          FROM (
            SELECT song_id FROM songSinger WHERE artist_id = a.id
            UNION
            SELECT song_id FROM songLyrics WHERE artist_id = a.id
            UNION
            SELECT song_id FROM songmusician WHERE artist_id = a.id
          ) as rel
          JOIN songs s ON rel.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
        ) as songsCount 
      FROM artists a 
      ${whereClauseStr}
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

    if (!status) {
      const [activeSongsCheck] = await pool.query(
        `SELECT COUNT(DISTINCT rel.song_id) as total
         FROM (
           SELECT song_id FROM songSinger WHERE artist_id = ?
           UNION
           SELECT song_id FROM songLyrics WHERE artist_id = ?
           UNION
           SELECT song_id FROM songmusician WHERE artist_id = ?
         ) as rel
         JOIN songs s ON rel.song_id = s.id AND (s.status = 1 OR s.status = 'Active' OR s.status IS NULL)`,
        [id, id, id]
      );
      if (activeSongsCheck[0] && activeSongsCheck[0].total > 0) {
        return res.status(400).json({ 
          message: 'Cannot inactivate artist with active linked songs.',
          activeSongsCount: activeSongsCheck[0].total 
        });
      }
    }

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

    let query = 'SELECT id, name FROM artists WHERE (is_delete = 0 OR is_delete IS NULL)';
    let queryParams = [];
    if (id) {
      query += ' AND id != ?';
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

    const [rows] = await pool.query('SELECT * FROM artists WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)', [artistId]);
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

    const [countRows] = await pool.query(`
      SELECT COUNT(DISTINCT rel.song_id) as total
      FROM (
        SELECT song_id FROM songSinger WHERE artist_id = ?
        UNION
        SELECT song_id FROM songLyrics WHERE artist_id = ?
        UNION
        SELECT song_id FROM songmusician WHERE artist_id = ?
      ) as rel
      JOIN songs s ON rel.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
    `, [artistId, artistId, artistId]);
    const songsCount = countRows[0] ? countRows[0].total : 0;

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
      songsCount,
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

function formatImage(img, host) {
  if (!img || typeof img !== 'string') return null;
  const trimmed = img.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http') || trimmed.startsWith('data:')) return trimmed;
  return `${host}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

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

// GET /artists/:id/songs (Lazy-loaded songs with pagination)
exports.getArtistSongs = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const isExport = req.query.export === 'true';

    // Count query for total songs
    const [countRows] = await pool.query(`
      SELECT COUNT(DISTINCT rel.song_id) as total
      FROM (
        SELECT song_id FROM songSinger WHERE artist_id = ?
        UNION
        SELECT song_id FROM songLyrics WHERE artist_id = ?
        UNION
        SELECT song_id FROM songmusician WHERE artist_id = ?
      ) as rel
      JOIN songs s ON rel.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
    `, [artistId, artistId, artistId]);

    const totalCount = countRows[0] ? countRows[0].total : 0;

    let dataQuery = `
      SELECT DISTINCT s.id, s.name, s.imageUrl, s.isrcCode, s.versionType, s.is_singer, s.is_lyrics, s.is_musician, s.is_recordlabel,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id) as artist,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songLyrics sl JOIN artists art ON sl.artist_id = art.id WHERE sl.song_id = s.id) as lyricist,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songmusician sm JOIN artists art ON sm.artist_id = art.id WHERE sm.song_id = s.id) as musician
      FROM (
        SELECT song_id FROM songSinger WHERE artist_id = ?
        UNION
        SELECT song_id FROM songLyrics WHERE artist_id = ?
        UNION
        SELECT song_id FROM songmusician WHERE artist_id = ?
      ) as rel
      JOIN songs s ON rel.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
      ORDER BY s.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, [artistId, artistId, artistId]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [artistId, artistId, artistId, limit, offset]);
    }

    const songIds = rows.map(s => s.id);
    const songLabelsMap = await fetchSongLabelsMap(songIds, pool, host);
    const songConflictsMap = await fetchSongConflictsMap(songIds, pool);

    const formattedSongs = rows.map(s => {
      const parsedLabels = songLabelsMap[s.id] || [];
      const cCount = songConflictsMap[s.id] || 0;
      const conflictText = cCount > 0 ? `${cCount} ${cCount === 1 ? 'Conflict' : 'Conflicts'}` : 'No';
      const isRec = (s.is_recordlabel === 1 || s.is_recordlabel === true || s.is_recordlabel === '1') ? 25 : 0;
      const isLyr = (s.is_lyrics === 1 || s.is_lyrics === true || s.is_lyrics === '1') ? 25 : 0;
      const isMus = (s.is_musician === 1 || s.is_musician === true || s.is_musician === '1') ? 25 : 0;
      const isSing = (s.is_singer === 1 || s.is_singer === true || s.is_singer === '1') ? 25 : 0;
      const pct = isRec + isLyr + isMus + isSing;

      return {
        id: s.id,
        name: toTitleCase(s.name),
        artist: toTitleCase(s.artist) || 'Unknown Artist',
        lyrics: toTitleCase(s.lyricist) || '—',
        music: toTitleCase(s.musician) || '—',
        imageUrl: formatImage(s.imageUrl, host),
        image_url: formatImage(s.imageUrl, host),
        duration: '03:45',
        isrcCode: s.isrcCode || '—',
        versionType: s.versionType || 'Original',
        ownership: pct,
        ownershipPercentage: pct,
        ownershipPercentageText: `${pct}%`,
        conflictCount: cCount,
        conflicts: conflictText,
        conflict: conflictText,
        status: 'Active',
        labels: parsedLabels,
        recordLabels: parsedLabels,
        labelNames: parsedLabels.map(l => l.name).join(', ') || 'None'
      };
    });

    res.json({
      songs: formattedSongs,
      totalCount,
      hasMore: offset + formattedSongs.length < totalCount
    });
  } catch (error) {
    console.error('Error fetching artist songs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /artists/:id/albums (Lazy-loaded albums for selected artist)
exports.getArtistAlbums = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);

    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const [rows] = await pool.query(`
      SELECT DISTINCT 
        a.id, 
        a.name, 
        a.image_url as image_url, 
        a.record_label_id,
        COALESCE(rl.display_name, rl.name) as record_label_name,
        rl.image_url as record_label_image,
        (SELECT COUNT(DISTINCT sa_count.song_id) 
         FROM songalbum sa_count 
         JOIN songs s_count ON sa_count.song_id = s_count.id AND (s_count.status = 1 OR s_count.status IS NULL)
         WHERE sa_count.album_id = a.id AND (sa_count.status = 1 OR sa_count.status IS NULL) AND (sa_count.is_delete = 0 OR sa_count.is_delete IS NULL)
        ) as track_count
      FROM (
        SELECT song_id FROM songSinger WHERE artist_id = ?
        UNION
        SELECT song_id FROM songLyrics WHERE artist_id = ?
        UNION
        SELECT song_id FROM songmusician WHERE artist_id = ?
      ) as artist_songs
      JOIN songalbum sa ON artist_songs.song_id = sa.song_id AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
      JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
      LEFT JOIN record_label rl ON a.record_label_id = rl.id AND (rl.status = 1 OR rl.status IS NULL) AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
      ORDER BY a.name ASC
    `, [artistId, artistId, artistId]);

    const formattedAlbums = rows.map(a => {
      const albumImg = formatImage(a.image_url, host);
      const labelImg = formatImage(a.record_label_image, host);
      return {
        id: a.id,
        name: toTitleCase(a.name),
        image_url: albumImg,
        imageUrl: albumImg,
        coverUrl: albumImg,
        track_count: a.track_count || 0,
        songsCount: a.track_count || 0,
        record_label: a.record_label_id ? {
          id: a.record_label_id,
          name: toTitleCase(a.record_label_name || ''),
          display_name: toTitleCase(a.record_label_name || ''),
          image_url: labelImg,
          imageUrl: labelImg
        } : null,
        recordLabelName: toTitleCase(a.record_label_name || '—'),
        recordLabelImage: labelImg
      };
    });

    res.json({
      albums: formattedAlbums,
      totalCount: formattedAlbums.length
    });
  } catch (error) {
    console.error('Error fetching artist albums:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /artists/:id (Soft delete artist by setting is_delete = 1)
exports.deleteArtist = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);
    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    // Check active linked songs across songSinger, songLyrics, songmusician
    const [countRows] = await pool.query(
      `SELECT COUNT(DISTINCT rel.song_id) as total
       FROM (
         SELECT song_id FROM songSinger WHERE artist_id = ?
         UNION
         SELECT song_id FROM songLyrics WHERE artist_id = ?
         UNION
         SELECT song_id FROM songmusician WHERE artist_id = ?
       ) as rel
       JOIN songs s ON rel.song_id = s.id AND (s.status = 1 OR s.status = 'Active' OR s.status IS NULL)`,
      [artistId, artistId, artistId]
    );

    if (countRows[0] && countRows[0].total > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete artist with active linked songs.',
        activeSongsCount: countRows[0].total 
      });
    }

    await pool.query(
      'UPDATE artists SET is_delete = 1, status = 0 WHERE id = ?',
      [artistId]
    );

    res.json({ message: 'Artist deleted successfully' });
  } catch (error) {
    console.error('Error deleting artist:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

