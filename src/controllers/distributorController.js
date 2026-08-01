const { getPool } = require('../config/db');
const { createAuditLog } = require('../utils/auditLogger');

// Helper to convert string to Title Case (capitalizing the first letter of each word)
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function parseRawLabels(rawStr, host) {
  if (!rawStr) return [];
  return rawStr.split('|||').map(entry => {
    const parts = entry.split(':::');
    const id = parts[0] ? parseInt(parts[0], 10) : null;
    const name = parts[1] || '';
    const img = parts[2] || null;
    const formattedImg = img ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`) : null;
    return {
      id,
      name: toTitleCase(name),
      imageUrl: formattedImg,
      image_url: formattedImg
    };
  }).filter(l => l.name);
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

    // Fetch records with distinct song count and active conflicts count
    let dataQuery = `
      SELECT d.*, 
             (SELECT COUNT(DISTINCT sd.song_id) 
              FROM songdistributor sd 
              WHERE sd.distributor_id = d.id AND sd.status = 1 AND sd.is_deleted = 0) as songCount,
             (SELECT COUNT(DISTINCT sc.Id) 
              FROM songdistributor sd
              JOIN songs s ON sd.song_id = s.id
              JOIN SongConflict sc ON sc.SongId = s.id
              WHERE sd.distributor_id = d.id 
                AND sd.status = 1 
                AND sd.is_deleted = 0 
                AND s.status = 1 
                AND sc.Status = 1 
                AND sc.IsDeleted = 0) as conflictCount
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

    const distIds = rows.map(r => r.id);
    let distLabelsMap = {};
    if (distIds.length > 0) {
      const host = `${req.protocol}://${req.get('host')}`;
      const [distLabelRows] = await pool.query(`
        SELECT DISTINCT sd.distributor_id, rl.id as label_id, COALESCE(rl.display_name, rl.name) as label_name, rl.image_url as label_image
        FROM songdistributor sd
        JOIN songalbum sa ON sd.song_id = sa.song_id AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
        JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
        JOIN record_label rl ON a.record_label_id = rl.id 
          AND (rl.status = 1 OR rl.status IS NULL) 
          AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
        WHERE sd.distributor_id IN (?) AND sd.status = 1 AND sd.is_deleted = 0
      `, [distIds]);

      distLabelRows.forEach(rel => {
        if (!distLabelsMap[rel.distributor_id]) distLabelsMap[rel.distributor_id] = [];
        if (rel.label_name && !distLabelsMap[rel.distributor_id].some(l => String(l.id) === String(rel.label_id))) {
          const img = rel.label_image;
          const formattedImg = formatImage(img, host);
          distLabelsMap[rel.distributor_id].push({
            id: rel.label_id,
            name: toTitleCase(rel.label_name),
            imageUrl: formattedImg,
            image_url: formattedImg
          });
        }
      });
    }

    res.json({
      distributors: rows.map(r => {
        const parsedLabels = distLabelsMap[r.id] || [];
        return {
          id: r.id,
          distributor_code: r.distributor_code,
          email: r.email,
          company: toTitleCase(r.company_name),
          labels: parsedLabels,
          recordLabels: parsedLabels,
          songCount: r.songCount || 0,
          percentage: r.outgoing_percentage,
          status: r.status === 1 || r.status === true ? 'Active' : 'Inactive',
          notes: '0 notes',
          conflicts: `${r.conflictCount || 0} ${r.conflictCount === 1 ? 'conflict' : 'conflicts'}`
        };
      }),
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

function formatImage(img, host) {
  return img ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`) : null;
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

async function fetchSongNotesCasesMap(songs, pool) {
  if (!Array.isArray(songs) || songs.length === 0) return {};
  try {
    const [ncRows] = await pool.query(
      `SELECT id, type, name, link_type, link_result
       FROM notesandcases
       WHERE status = 1 AND is_delete = 0`
    );

    const map = {};
    songs.forEach(song => {
      const sIdStr = String(song.id);
      const sName = (song.name || '').toLowerCase().trim();
      const sSinhala = (song.nameSinhala || '').toLowerCase().trim();

      const matchedItems = ncRows.filter(r => {
        const linkVal = (r.link_result || '').toLowerCase().trim();
        if (!linkVal) return false;
        if (linkVal === sIdStr) return true;
        if (sName && (linkVal.includes(sName) || linkVal === sName)) return true;
        if (sSinhala && (linkVal.includes(sSinhala) || linkVal === sSinhala)) return true;
        if (r.name && sName && r.name.toLowerCase().includes(sName)) return true;
        return false;
      });

      if (matchedItems.length > 0) {
        map[song.id] = matchedItems.map(m => `${m.type === 'case' ? 'Case' : 'Note'}: ${m.name}`).join('; ');
      } else {
        map[song.id] = song.notes && song.notes.trim() ? song.notes : 'No Cases Or Notes';
      }
    });

    return map;
  } catch (err) {
    console.error('Error fetching song notes/cases map:', err);
    return {};
  }
}

// GET /distributor/:id/songs
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

    const host = `${req.protocol}://${req.get('host')}`;

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM songdistributor sd
       JOIN songs s ON sd.song_id = s.id
       WHERE sd.distributor_id = ? AND sd.status = 1 AND sd.is_deleted = 0 AND s.status = 1`,
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
             s.is_singer, s.is_lyrics, s.is_musician, s.is_recordlabel,
             sd.status as mapping_status
      FROM songdistributor sd
      JOIN songs s ON sd.song_id = s.id
      WHERE sd.distributor_id = ? AND sd.status = 1 AND sd.is_deleted = 0 AND s.status = 1
      ORDER BY s.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, [distributorId]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [distributorId, limit, offset]);
    }

    const songIds = rows.map(s => s.id);
    const songLabelsMap = await fetchSongLabelsMap(songIds, pool, host);
    const songConflictsMap = await fetchSongConflictsMap(songIds, pool);
    const songNotesCasesMap = await fetchSongNotesCasesMap(rows, pool);

    res.json({
      songs: rows.map(s => {
        const parsedLabels = songLabelsMap[s.id] || [];
        const cCount = songConflictsMap[s.id] || 0;
        const conflictText = cCount > 0 ? `${cCount} ${cCount === 1 ? 'Conflict' : 'Conflicts'}` : 'No';
        const isRec = (s.is_recordlabel === 1 || s.is_recordlabel === true || s.is_recordlabel === '1') ? 50 : 0;
        const isLyr = (s.is_lyrics === 1 || s.is_lyrics === true || s.is_lyrics === '1') ? 25 : 0;
        const isMus = (s.is_musician === 1 || s.is_musician === true || s.is_musician === '1') ? 25 : 0;
        const pct = isRec + isLyr + isMus;

        return {
          id: s.id,
          name: toTitleCase(s.name),
          artist: toTitleCase(s.artist) || 'Unknown Artist',
          lyrics: toTitleCase(s.lyricist) || '—',
          music: toTitleCase(s.musician) || '—',
          album: s.album || '—',
          labels: parsedLabels,
          recordLabels: parsedLabels,
          labelNames: parsedLabels.map(l => l.name).join(', ') || 'None',
          releaseDate: s.release_date ? (typeof s.release_date === 'object' ? s.release_date.toISOString().split('T')[0] : String(s.release_date).split('T')[0]) : '—',
          isrcCode: s.isrcCode || '—',
          versionType: s.versionType || 'Original',
          ownership: pct,
          ownershipPercentage: pct,
          ownershipPercentageText: `${pct}%`,
          notes: songNotesCasesMap[s.id] || s.notes || 'No Cases Or Notes',
          conflictCount: cCount,
          conflicts: conflictText,
          conflict: conflictText,
          status: s.mapping_status === 1 || s.mapping_status === true ? 'Active' : 'Inactive'
        };
      }),
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

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(lowercaseEmail)) {
      return res.status(400).json({ message: 'Invalid email address format' });
    }

    // Email uniqueness validation (company name is no longer blocked)
    const [existing] = await pool.query(
      `SELECT id, email FROM distributors 
       WHERE LOWER(email) = ? AND is_deleted = 0`,
      [lowercaseEmail]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const distributor_code = await generateDistributorCode(pool);
    const status = 1;

    const [result] = await pool.query(
      `INSERT INTO distributors (distributor_code, email, company_name, outgoing_percentage, status, is_deleted) 
       VALUES (?, ?, ?, ?, ?, 0)`,
      [distributor_code, lowercaseEmail, company.trim().toLowerCase(), parseFloat(percentage), status]
    );

    res.status(201).json({
      id: result.insertId,
      distributor_code,
      email: lowercaseEmail,
      company: toTitleCase(company.trim()),
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

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(lowercaseEmail)) {
      return res.status(400).json({ message: 'Invalid email address format' });
    }

    // Email uniqueness validation (company name is no longer blocked)
    const [existing] = await pool.query(
      `SELECT id, email FROM distributors 
       WHERE LOWER(email) = ? AND is_deleted = 0 AND id != ?`,
      [lowercaseEmail, id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const [currentDist] = await pool.query('SELECT status FROM distributors WHERE id = ? AND is_deleted = 0', [id]);
    if (currentDist.length === 0) {
      return res.status(404).json({ message: 'Distributor not found' });
    }

    let dbStatus = currentDist[0].status;
    if (status !== undefined) {
      dbStatus = status === 'Active' || status === true || status === 1 || status === '1' ? 1 : 0;
    }

    await pool.query(
      `UPDATE distributors 
       SET email = ?, company_name = ?, outgoing_percentage = ?, status = ? 
       WHERE id = ?`,
      [lowercaseEmail, company.trim().toLowerCase(), parseFloat(percentage), dbStatus, id]
    );

    res.json({
      id: parseInt(id, 10),
      email: lowercaseEmail,
      company: toTitleCase(company.trim()),
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

    const validDependencies = dependencies.filter(row => row.id !== null);

    if (validDependencies.length > 0 && !force) {
      return res.json({
        success: false,
        hasDependencies: true,
        dependentSongs: validDependencies.map(row => ({
          id: row.id,
          name: toTitleCase(row.name),
          artist: toTitleCase(row.artist) || 'Unknown Artist',
          album: '—'
        }))
      });
    }

    // Set distributor status = 0
    await pool.query('UPDATE distributors SET status = 0 WHERE id = ?', [id]);
    // Set all related songdistributor mapping status = 0 (only non-deleted)
    await pool.query('UPDATE songdistributor SET status = 0 WHERE distributor_id = ? AND is_deleted = 0', [id]);

    res.json({
      success: true,
      hasDependencies: false
    });
  } catch (error) {
    console.error('Error inactivating distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Activate / Reactivate distributor (restores status = 1 and related non-deleted song mappings to status = 1)
exports.activateDistributor = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    // Set distributor status = 1 (active)
    await pool.query('UPDATE distributors SET status = 1 WHERE id = ? AND is_deleted = 0', [id]);
    // Set all related non-deleted songdistributor mapping status = 1
    await pool.query('UPDATE songdistributor SET status = 1 WHERE distributor_id = ? AND is_deleted = 0', [id]);

    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error activating distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Delete distributor (soft delete by setting is_deleted = 1)
exports.deleteDistributor = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.query.force === 'true' || req.body.force === true;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    // Verify distributor is inactive before deleting
    const [distRows] = await pool.query('SELECT status FROM distributors WHERE id = ? AND is_deleted = 0', [id]);
    if (distRows.length === 0) {
      return res.status(404).json({ message: 'Distributor not found' });
    }
    if (distRows[0].status === 1) {
      return res.status(400).json({ message: 'Active distributors cannot be deleted. Please inactivate first.' });
    }

    // Check related non-deleted song relationships in songdistributor
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songdistributor sd
       JOIN songs s ON sd.song_id = s.id
       WHERE sd.distributor_id = ? AND sd.is_deleted = 0`,
      [id]
    );

    const validDependencies = dependencies.filter(row => row.id !== null);

    if (validDependencies.length > 0 && !force) {
      return res.json({
        success: false,
        hasDependencies: true,
        dependentSongs: validDependencies.map(row => ({
          id: row.id,
          name: toTitleCase(row.name),
          artist: toTitleCase(row.artist) || 'Unknown Artist',
          album: '—'
        }))
      });
    }

    // Update distributors table to set is_deleted = 1
    await pool.query('UPDATE distributors SET is_deleted = 1 WHERE id = ?', [id]);
    // Update related songdistributor table to set is_deleted = 1
    await pool.query('UPDATE songdistributor SET is_deleted = 1 WHERE distributor_id = ?', [id]);

    res.json({
      success: true,
      hasDependencies: false
    });
  } catch (error) {
    console.error('Error deleting distributor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get distributor active conflicts (status = 1 songs, status = 1 songdistributor mapping, status = 1 active conflict)
exports.getDistributorConflicts = async (req, res) => {
  try {
    const pool = getPool();
    const distributorId = parseInt(req.params.id, 10);

    if (isNaN(distributorId)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    const [rows] = await pool.query(
      `SELECT 
         s.id as songId, 
         s.name, 
         (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
         (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = s.id) as lyricist,
         (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = s.id) as musician,
         s.ownership,
         s.notes,
         sc.Id as conflictId,
         sc.CopyrightConflict as copyrightConflict,
         sc.ConflictOwner as conflictOwner,
         sc.ConflictDate as conflictDate
       FROM songdistributor sd
       JOIN songs s ON sd.song_id = s.id
       JOIN SongConflict sc ON sc.SongId = s.id
       WHERE sd.distributor_id = ?
         AND sd.status = 1 
         AND sd.is_deleted = 0
         AND s.status = 1
         AND sc.Status = 1
         AND sc.IsDeleted = 0
       ORDER BY s.name ASC`,
      [distributorId]
    );

    const host = `${req.protocol}://${req.get('host')}`;
    const songIds = rows.map(r => r.songId);
    const songLabelsMap = await fetchSongLabelsMap(songIds, pool, host);

    res.json({
      conflicts: rows.map(r => {
        const parsedLabels = songLabelsMap[r.songId] || [];
        return {
          id: r.conflictId,
          songId: r.songId,
          name: toTitleCase(r.name),
          artist: toTitleCase(r.artist) || 'Unknown Artist',
          lyrics: toTitleCase(r.lyricist) || '—',
          music: toTitleCase(r.musician) || '—',
          labels: parsedLabels,
          recordLabels: parsedLabels,
          ownership: r.ownership ? `${r.ownership}%` : '100%',
          conflictOwner: toTitleCase(r.conflictOwner) || '—',
          copyrightConflict: r.copyrightConflict || 'Sound Records',
          notes: r.notes || 'No Cases Or Notes'
        };
      })
    });
  } catch (error) {
    console.error('Error fetching distributor conflicts:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /distributor/:id/labels (Unique record labels associated with songs under this distributor)
exports.getDistributorLabels = async (req, res) => {
  try {
    const pool = getPool();
    const distributorId = parseInt(req.params.id, 10);

    if (isNaN(distributorId)) {
      return res.status(400).json({ message: 'Invalid distributor ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    const [rows] = await pool.query(`
      SELECT 
        rl.id, 
        COALESCE(rl.display_name, rl.name) as label_name, 
        rl.image_url as label_image,
        COUNT(DISTINCT sd.song_id) as song_count
      FROM songdistributor sd
      JOIN songs s ON sd.song_id = s.id AND (s.status = 1 OR s.status IS NULL)
      JOIN songalbum sa ON s.id = sa.song_id AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
      JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
      JOIN record_label rl ON a.record_label_id = rl.id 
        AND (rl.status = 1 OR rl.status IS NULL) 
        AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
      WHERE sd.distributor_id = ? 
        AND (sd.status = 1 OR sd.status IS NULL) 
        AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL)
      GROUP BY rl.id, rl.display_name, rl.name, rl.image_url
      ORDER BY label_name ASC
    `, [distributorId]);

    const labels = rows.map(r => {
      const img = formatImage(r.label_image, host);
      const name = toTitleCase(r.label_name || 'Record Label');
      return {
        id: r.id,
        name,
        display_name: name,
        image_url: img,
        imageUrl: img,
        songCount: r.song_count || 0
      };
    });

    res.json({ labels });
  } catch (error) {
    console.error('Error fetching distributor labels:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
