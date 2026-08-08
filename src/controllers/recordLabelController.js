const { getPool } = require('../config/db');
const { createAuditLog } = require('../utils/auditLogger');

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

    // Data query with song count (via album -> songalbum -> songs), pre-aggregated once via
    // a derived table instead of a correlated subquery re-executed for every record label row.
    let dataQuery = `
      SELECT rl.*, COALESCE(songAgg.songCount, 0) as songCount
      FROM record_label rl
      LEFT JOIN (
        SELECT a.record_label_id, COUNT(DISTINCT sa.song_id) as songCount
        FROM songalbum sa
        JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
        JOIN songs s ON sa.song_id = s.id
        WHERE (sa.status = 1 OR sa.status IS NULL) 
          AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
          AND s.status = 1
        GROUP BY a.record_label_id
      ) songAgg ON songAgg.record_label_id = rl.id
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
      const img = r.image_url ? (r.image_url.startsWith('http') || r.image_url.startsWith('data:') ? r.image_url : `${host}${r.image_url.startsWith('/') ? '' : '/'}${r.image_url}`) : null;
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
              (SELECT COUNT(DISTINCT sa.song_id)
               FROM songalbum sa
               JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
               JOIN songs s ON sa.song_id = s.id
               WHERE a.record_label_id = rl.id 
                 AND (sa.status = 1 OR sa.status IS NULL) 
                 AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
                 AND s.status = 1) as songCount
       FROM record_label rl
       WHERE rl.id = ? AND rl.is_delete = 0`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Record label not found' });
    }

    const r = rows[0];
    const host = `${req.protocol}://${req.get('host')}`;
    const img = r.image_url ? (r.image_url.startsWith('http') || r.image_url.startsWith('data:') ? r.image_url : `${host}${r.image_url.startsWith('/') ? '' : '/'}${r.image_url}`) : null;

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
      created_at: r.created_at,
      updated_at: r.updated_at
    });
  } catch (error) {
    console.error('Error fetching record label by ID:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

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
      const formattedImg = img ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`) : null;
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

    const host = `${req.protocol}://${req.get('host')}`;

    const [countRows] = await pool.query(
      `SELECT COUNT(DISTINCT sa.song_id) as total
       FROM songalbum sa
       JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
       JOIN songs s ON sa.song_id = s.id
       WHERE a.record_label_id = ? 
         AND (sa.status = 1 OR sa.status IS NULL) 
         AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
         AND s.status = 1`,
      [labelId]
    );
    const totalCount = countRows[0].total;

    const isExport = req.query.export === 'true';

    let dataQuery = `
      SELECT s.id, s.name, MIN(sa.created_at) as release_date,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id) as artist,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songLyrics sl JOIN artists art ON sl.artist_id = art.id WHERE sl.song_id = s.id) as lyricist,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songmusician sm JOIN artists art ON sm.artist_id = art.id WHERE sm.song_id = s.id) as musician,
              s.isrcCode,
              s.versionType,
              s.is_singer, s.is_lyrics, s.is_musician, s.is_recordlabel
       FROM songalbum sa
       JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
       JOIN songs s ON sa.song_id = s.id
       WHERE a.record_label_id = ? 
         AND (sa.status = 1 OR sa.status IS NULL) 
         AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
         AND s.status = 1
       GROUP BY s.id
       ORDER BY s.name ASC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, [labelId]);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [labelId, limit, offset]);
    }

    const songIds = rows.map(s => s.id);
    const [songLabelsMap, songConflictsMap, songNotesCasesMap] = await Promise.all([
      fetchSongLabelsMap(songIds, pool, host),
      fetchSongConflictsMap(songIds, pool),
      fetchSongNotesCasesMap(rows, pool)
    ]);

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
          album: '—',
          labels: parsedLabels,
          recordLabels: parsedLabels,
          labelNames: parsedLabels.map(l => l.name).join(', ') || 'None',
          releaseDate: s.release_date ? String(s.release_date).split('T')[0] : '—',
          isrcCode: s.isrcCode || '—',
          versionType: s.versionType || 'Original',
          ownership: pct,
          ownershipPercentage: pct,
          ownershipPercentageText: `${pct}%`,
          notes: songNotesCasesMap[s.id] || s.notes || 'No Cases Or Notes',
          conflictCount: cCount,
          conflicts: conflictText,
          conflict: conflictText,
          status: 'Active'
        };
      }),
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
    const img = image_url ? (image_url.startsWith('http') || image_url.startsWith('data:') ? image_url : `${host}${image_url.startsWith('/') ? '' : '/'}${image_url}`) : null;

    await createAuditLog({
      user: req.user || null,
      action: 'CREATE_RECORD_LABEL',
      details: `Created record label ${displayName}`
    });

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

    await createAuditLog({
      user: req.user || null,
      action: 'UPDATE_RECORD_LABEL',
      details: `Updated record label ${displayName}`
    });

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

    // Check active song relationships via albums
    const [dependencies] = await pool.query(
      `SELECT DISTINCT s.id, s.name,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id) as artist,
              a.name as album
       FROM songalbum sa
       JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
       JOIN songs s ON sa.song_id = s.id
       WHERE a.record_label_id = ? 
         AND (sa.status = 1 OR sa.status IS NULL) 
         AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
         AND s.status = 1`,
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
          album: toTitleCase(row.album) || '—'
        }))
      });
    }

    // Deactivate record_label
    await pool.query('UPDATE record_label SET status = 0 WHERE id = ?', [id]);

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

    // Check related songs via album
    const [dependencies] = await pool.query(
      `SELECT DISTINCT s.id, s.name,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id) as artist,
              a.name as album
       FROM songalbum sa
       JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
       JOIN songs s ON sa.song_id = s.id
       WHERE a.record_label_id = ? 
         AND (sa.status = 1 OR sa.status IS NULL) 
         AND (sa.is_delete = 0 OR sa.is_delete IS NULL)`,
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
          album: toTitleCase(row.album) || '—'
        }))
      });
    }

    // Soft delete
    await pool.query('UPDATE record_label SET is_delete = 1 WHERE id = ?', [id]);

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
