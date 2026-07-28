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

// Get all ringtone operators (active + inactive, excluding is_deleted = 1)
exports.getRingtones = async (req, res) => {
  try {
    const pool = getPool();

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const isExport = req.query.export === 'true';

    const search = req.query.search || '';

    // Filter: show active + inactive but exclude soft-deleted
    let whereClauses = ['r.is_deleted = 0'];
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

    // Fetch records (Distinct song count — only active, non-deleted relationships)
    let dataQuery = `
      SELECT r.*, COUNT(DISTINCT sr.song_id) as songCount
      FROM ringintone r
      LEFT JOIN songringintone sr ON r.id = sr.ringintone_id AND sr.status = 1 AND sr.is_deleted = 0
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

// Get single ringtone operator (non-deleted)
exports.getRingtoneById = async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const [rows] = await pool.query('SELECT * FROM ringintone WHERE id = ? AND is_deleted = 0', [id]);
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

    // Check if name is unique (ignore soft-deleted records)
    const [existing] = await pool.query('SELECT id FROM ringintone WHERE LOWER(name) = ? AND is_deleted = 0', [lowercaseName]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Ringtone account with this name already exists.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Operator logo file is required.' });
    }

    const company_logo = `/uploads/images/${req.file.filename}`;

    const status = 1; // Default Active (true)

    const [result] = await pool.query(
      `INSERT INTO ringintone (name, company_logo, status, is_deleted) 
       VALUES (?, ?, ?, 0)`,
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

    const [existing] = await pool.query('SELECT * FROM ringintone WHERE id = ? AND is_deleted = 0', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Operator not found' });
    }

    const lowercaseName = name.trim().toLowerCase();

    // Check if name is unique (ignore soft-deleted records)
    const [duplicate] = await pool.query('SELECT id FROM ringintone WHERE LOWER(name) = ? AND id != ? AND is_deleted = 0', [lowercaseName, id]);
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

// Inactivate ringtone operator (soft inactivates related song mappings)
exports.inactivateRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.query.force === 'true' || req.body.force === true;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid operator ID' });
    }

    // Check active song relationships (only non-deleted)
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songringintone sr
       JOIN songs s ON sr.song_id = s.id
       WHERE sr.ringintone_id = ? AND sr.status = 1 AND sr.is_deleted = 0 AND s.status = 1 AND s.is_delete = 0`,
      [id]
    );

    // Filter out null rows (LEFT JOIN can return null id)
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

    // Set ringtone status = 0
    await pool.query('UPDATE ringintone SET status = 0 WHERE id = ?', [id]);
    // Set all related non-deleted songringintone mapping status = 0
    await pool.query('UPDATE songringintone SET status = 0 WHERE ringintone_id = ? AND is_deleted = 0', [id]);

    res.json({
      success: true,
      hasDependencies: false
    });
  } catch (error) {
    console.error('Error inactivating ringtone:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Activate ringtone operator (restores related non-deleted song mappings)
exports.activateRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid operator ID' });
    }

    // Set ringtone status = 1
    await pool.query('UPDATE ringintone SET status = 1 WHERE id = ? AND is_deleted = 0', [id]);
    // Restore only related song mappings for songs that are active and not soft-deleted
    await pool.query(
      `UPDATE songringintone sr
       JOIN songs s ON sr.song_id = s.id
       SET sr.status = 1
       WHERE sr.ringintone_id = ? AND sr.is_deleted = 0 AND s.status = 1 AND s.is_delete = 0`,
      [id]
    );

    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error activating ringtone:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Delete ringtone operator (soft delete by setting is_deleted = 1)
exports.deleteRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const force = req.query.force === 'true' || req.body.force === true;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid operator ID' });
    }

    // Verify the ringtone is inactive before allowing delete
    const [ringtoneRows] = await pool.query('SELECT status FROM ringintone WHERE id = ? AND is_deleted = 0', [id]);
    if (ringtoneRows.length === 0) {
      return res.status(404).json({ message: 'Operator not found' });
    }
    if (ringtoneRows[0].status === 1) {
      return res.status(400).json({ message: 'Active ringtones cannot be deleted. Please inactivate first.' });
    }

    // Check inactive, non-deleted SongRingtone dependencies
    const [dependencies] = await pool.query(
      `SELECT s.id, s.name,
              (SELECT GROUP_CONCAT(a.name SEPARATOR ', ') FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = s.id) as artist,
              '—' as album
       FROM songringintone sr
       JOIN songs s ON sr.song_id = s.id
       WHERE sr.ringintone_id = ? AND sr.status = 0 AND sr.is_deleted = 0`,
      [id]
    );

    // Filter out null rows
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

    // Soft delete: set is_deleted = 1 for ringtone
    await pool.query('UPDATE ringintone SET is_deleted = 1 WHERE id = ?', [id]);
    // Soft delete: set is_deleted = 1 for all related songringintone records
    await pool.query('UPDATE songringintone SET is_deleted = 1 WHERE ringintone_id = ?', [id]);

    res.json({
      success: true,
      hasDependencies: false
    });
  } catch (error) {
    console.error('Error deleting ringtone:', error);
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

    const host = `${req.protocol}://${req.get('host')}`;

    // Check total count of active songs mapping to this ringtone (exclude deleted)
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM songringintone sr
       JOIN songs s ON sr.song_id = s.id
       WHERE sr.ringintone_id = ? 
         AND (sr.status = 1 OR sr.status IS NULL) 
         AND (sr.is_deleted = 0 OR sr.is_deleted IS NULL) 
         AND (s.status = 1 OR s.status IS NULL)`,
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
             s.is_singer, s.is_lyrics, s.is_musician, s.is_recordlabel
      FROM songringintone sr
      JOIN songs s ON sr.song_id = s.id
      LEFT JOIN songdistributor sd ON s.id = sd.song_id AND (sd.status = 1 OR sd.status IS NULL) AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL)
      LEFT JOIN distributors dist ON sd.distributor_id = dist.id
      WHERE sr.ringintone_id = ? 
        AND (sr.status = 1 OR sr.status IS NULL) 
        AND (sr.is_deleted = 0 OR sr.is_deleted IS NULL) 
        AND (s.status = 1 OR s.status IS NULL)
      ORDER BY s.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, [ringtoneId]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [ringtoneId, limit, offset]);
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
          distributor: toTitleCase(s.distributor) || '—',
          releaseDate: s.release_date ? (typeof s.release_date === 'object' ? s.release_date.toISOString().split('T')[0] : String(s.release_date).split('T')[0]) : '—',
          isrcCode: s.isrcCode || '—',
          versionType: s.versionType || 'Original',
          ownership: pct,
          ownershipPercentage: pct,
          ownershipPercentageText: `${pct}%`,
          notes: songNotesCasesMap[s.id] || s.notes || 'No Cases Or Notes',
          conflictCount: cCount,
          conflicts: conflictText,
          conflict: conflictText
        };
      }),
      totalCount
    });
  } catch (error) {
    console.error('Error fetching ringtone songs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
