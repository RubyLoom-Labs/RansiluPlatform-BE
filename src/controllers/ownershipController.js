const { getPool } = require('../config/db');

function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatImage(img, host) {
  if (!img || typeof img !== 'string') return null;
  const trimmed = img.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http') || trimmed.startsWith('data:')) return trimmed;
  return `${host}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

function extractDocName(req) {
  if (!req) return '';
  const body = req.body || {};
  const query = req.query || {};
  const name = body.document_name || body.name || body.documentName || body.docName ||
               query.document_name || query.name || query.documentName || query.docName || '';
  return String(name).trim();
}

function extractUploadedFile(req) {
  if (req.file) return req.file;
  if (Array.isArray(req.files) && req.files.length > 0) return req.files[0];
  return null;
}

async function fetchSongLabelsMap(songIds, pool, host) {
  if (!Array.isArray(songIds) || songIds.length === 0) return {};
  try {
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
  } catch (err) {
    console.error('Error fetching song labels map:', err);
    return {};
  }
}

function parseSongsList(body) {
  let songs = body.songs;
  let song_ids = body.song_ids;

  if (typeof songs === 'string') {
    try { songs = JSON.parse(songs); } catch (e) { songs = null; }
  }
  if (typeof song_ids === 'string') {
    try { song_ids = JSON.parse(song_ids); } catch (e) { song_ids = null; }
  }

  if (Array.isArray(songs)) {
    return songs.map(item => {
      if (typeof item === 'object' && item !== null) {
        const sId = parseInt(item.id || item.song_id || item.value, 10);
        const oType = item.ownershipType || item.ownership_type || item.type || null;
        return { song_id: sId, ownership_type: oType };
      }
      return { song_id: parseInt(item, 10), ownership_type: null };
    }).filter(s => !isNaN(s.song_id));
  } else if (Array.isArray(song_ids)) {
    let typesMap = body.song_ownership_types || {};
    if (typeof typesMap === 'string') {
      try { typesMap = JSON.parse(typesMap); } catch (e) { typesMap = {}; }
    }
    return song_ids.map(sId => ({
      song_id: parseInt(sId, 10),
      ownership_type: typesMap[sId] || null
    })).filter(s => !isNaN(s.song_id));
  }
  return [];
}

// GET /ownership (handles list, pagination, search, export)
exports.getOwnerships = async (req, res) => {
  try {
    const pool = getPool();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || req.query.keyword || req.query.document_name || '';
    const isExport = req.query.export === 'true';

    let whereClauses = [
      'o.status = 1',
      'o.is_delete = 0',
      'os.status = 1',
      'os.is_delete = 0'
    ];
    let queryParams = [];

    if (search && search.trim()) {
      whereClauses.push('o.document_name LIKE ?');
      queryParams.push(`%${search.trim()}%`);
    }

    const whereClauseStr = 'WHERE ' + whereClauses.join(' AND ');

    const countQuery = `
      SELECT COUNT(DISTINCT o.id) as total
      FROM ownership o
      INNER JOIN ownershipsong os ON o.id = os.ownership_id
      ${whereClauseStr}
    `;

    const [countRows] = await pool.query(countQuery, queryParams);
    const totalRecords = countRows.length > 0 ? countRows[0].total : 0;
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    let dataQuery = `
      SELECT 
        o.id,
        o.document_name,
        o.document_tag,
        o.is_ownership,
        o.document_url,
        o.status,
        o.is_delete,
        o.created_at,
        o.updated_at,
        COUNT(DISTINCT os.song_id) as songCount
      FROM ownership o
      INNER JOIN ownershipsong os ON o.id = os.ownership_id
      ${whereClauseStr}
      GROUP BY o.id
      ORDER BY o.created_at DESC, o.id DESC
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
      const docFile = r.document_url || '/uploads/documents/sample-document.pdf';
      const formattedDocUrl = formatImage(docFile, host);
      return {
        id: r.id,
        name: r.document_name,
        document_name: r.document_name,
        document_tag: r.document_tag || '',
        tags: r.document_tag || '',
        is_ownership: r.is_ownership === 1,
        addToOwnership: r.is_ownership === 1 ? 'Yes' : 'No',
        songCount: r.songCount || 0,
        ownershipFor: 'Music, Lyrics, Recode label',
        document_url: formattedDocUrl,
        documentUrl: formattedDocUrl,
        status: r.status === 1 ? 'Active' : 'Inactive',
        created_at: r.created_at,
        updated_at: r.updated_at
      };
    });

    res.json({
      data: formattedList,
      documents: formattedList,
      currentPage: page,
      totalPages: totalPages,
      totalRecords: totalRecords
    });
  } catch (error) {
    console.error('Error fetching ownership records:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /ownership/search
exports.searchOwnership = async (req, res) => {
  req.query.search = req.query.search || req.query.keyword || req.query.document_name || '';
  return exports.getOwnerships(req, res);
};

// GET /ownership/export
exports.exportOwnership = async (req, res) => {
  req.query.export = 'true';
  return exports.getOwnerships(req, res);
};

// GET /ownership/:id
exports.getOwnershipById = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ownership ID' });
    }

    const [rows] = await pool.query(
      `SELECT o.*, COUNT(DISTINCT os.song_id) as songCount
       FROM ownership o
       INNER JOIN ownershipsong os ON o.id = os.ownership_id AND os.status = 1 AND os.is_delete = 0
       WHERE o.id = ? AND o.status = 1 AND o.is_delete = 0
       GROUP BY o.id`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Ownership document not found' });
    }

    const r = rows[0];

    const [songRows] = await pool.query(
      `SELECT s.id, s.name, s.nameSinhala, s.status, s.notes, s.conflict, os.ownership_type,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id AND (art.is_delete = 0 OR art.is_delete IS NULL)) as singerNames,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songLyrics sl JOIN artists art ON sl.artist_id = art.id WHERE sl.song_id = s.id AND (art.is_delete = 0 OR art.is_delete IS NULL)) as lyricistNames,
              (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songmusician sm JOIN artists art ON sm.artist_id = art.id WHERE sm.song_id = s.id AND (art.is_delete = 0 OR art.is_delete IS NULL)) as musicianNames
       FROM ownershipsong os
       JOIN songs s ON os.song_id = s.id AND (s.is_delete = 0 OR s.is_delete IS NULL)
       WHERE os.ownership_id = ? AND os.status = 1 AND os.is_delete = 0
       ORDER BY os.id ASC`,
      [id]
    );

    const host = `${req.protocol}://${req.get('host')}`;
    const songIds = songRows.map(s => s.id);
    const songLabelsMap = await fetchSongLabelsMap(songIds, pool, host);

    const songOwnershipTypesMap = {};
    songRows.forEach(s => {
      if (s.ownership_type) {
        songOwnershipTypesMap[s.id] = s.ownership_type;
      }
    });

    const docFile = r.document_url || '/uploads/documents/sample-document.pdf';
    const formattedDocUrl = formatImage(docFile, host);

    res.json({
      id: r.id,
      name: r.document_name,
      document_name: r.document_name,
      document_tag: r.document_tag || '',
      tags: r.document_tag || '',
      is_ownership: r.is_ownership === 1,
      addToOwnership: r.is_ownership === 1 ? 'Yes' : 'No',
      songCount: r.songCount || 0,
      ownershipFor: 'Music, Lyrics, Recode label',
      document_url: formattedDocUrl,
      documentUrl: formattedDocUrl,
      song_ids: songRows.map(s => String(s.id)),
      song_ownership_types: songOwnershipTypesMap,
      songs: songRows.map(s => {
        const labelsList = songLabelsMap[s.id] || [];
        return {
          id: s.id,
          name: s.nameSinhala ? `${toTitleCase(s.nameSinhala)} (${toTitleCase(s.name)})` : toTitleCase(s.name),
          rawName: s.name,
          nameSinhala: s.nameSinhala,
          status: s.status || 'Active',
          artist: toTitleCase(s.singerNames) || 'Singer',
          artistSub: 'Duo - Second Artist',
          lyrics: toTitleCase(s.lyricistNames) || '—',
          music: toTitleCase(s.musicianNames) || '—',
          labels: labelsList,
          recordLabels: labelsList,
          ownershipType: s.ownership_type || 'melody',
          ownership_type: s.ownership_type || 'melody',
          notes: s.notes || 'No Cases Or Notes',
          conflict: s.conflict || 'No'
        };
      })
    });
  } catch (error) {
    console.error('Error fetching ownership by ID:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /ownership
exports.createOwnership = async (req, res) => {
  try {
    const pool = getPool();
    let docName = extractDocName(req);

    if (!docName) {
      docName = 'Untitled Ownership Document';
    }

    const songsList = parseSongsList(req.body);
    if (songsList.length === 0) {
      return res.status(400).json({ message: 'Please select at least one song' });
    }

    const unassigned = songsList.filter(s => !s.ownership_type || !String(s.ownership_type).trim());
    if (unassigned.length > 0) {
      return res.status(400).json({ message: 'Ownership type is mandatory for each selected song.' });
    }

    const docTag = req.body.document_tag !== undefined ? req.body.document_tag : (req.body.tags || '');
    const isOwn = req.body.is_ownership !== undefined ? (req.body.is_ownership == 1 || req.body.is_ownership === true || req.body.is_ownership === 'true' ? 1 : 0) : 1;

    let docUrl = req.body.document_url || '';
    const uploadedFile = extractUploadedFile(req);
    if (uploadedFile) {
      docUrl = `/uploads/documents/${uploadedFile.filename}`;
    }
    if (!docUrl) {
      docUrl = '/uploads/documents/sample-document.pdf';
    }

    const [result] = await pool.query(
      `INSERT INTO ownership (document_name, document_tag, is_ownership, document_url, status, is_delete)
       VALUES (?, ?, ?, ?, 1, 0)`,
      [docName, docTag, isOwn, docUrl]
    );

    const ownershipId = result.insertId;

    for (const songObj of songsList) {
      await pool.query(
        `INSERT INTO ownershipsong (song_id, ownership_id, ownership_type, status, is_delete)
         VALUES (?, ?, ?, 1, 0)`,
        [songObj.song_id, ownershipId, songObj.ownership_type]
      );
    }

    res.status(201).json({
      message: 'Ownership document created successfully',
      id: ownershipId
    });
  } catch (error) {
    console.error('Error creating ownership document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /ownership/:id/songs
exports.addSongsToOwnership = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const { song_id, ownership_type } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ownership ID' });
    }

    const [docRows] = await pool.query(
      `SELECT id FROM ownership WHERE id = ? AND status = 1 AND is_delete = 0`,
      [id]
    );

    if (docRows.length === 0) {
      return res.status(404).json({ message: 'Ownership document not found' });
    }

    let songsList = parseSongsList(req.body);
    if (songsList.length === 0 && song_id) {
      songsList.push({
        song_id: parseInt(song_id, 10),
        ownership_type: ownership_type || ''
      });
    }

    if (songsList.length === 0) {
      return res.status(400).json({ message: 'Please select at least one song to add' });
    }

    const unassigned = songsList.filter(s => !s.ownership_type || !String(s.ownership_type).trim());
    if (unassigned.length > 0) {
      return res.status(400).json({ message: 'Ownership type is mandatory for each selected song.' });
    }

    for (const songObj of songsList) {
      const sId = songObj.song_id;
      const oType = songObj.ownership_type;

      const [existing] = await pool.query(
        `SELECT id FROM ownershipsong WHERE ownership_id = ? AND song_id = ?`,
        [id, sId]
      );

      if (existing.length > 0) {
        await pool.query(
          `UPDATE ownershipsong SET ownership_type = ?, status = 1, is_delete = 0 WHERE id = ?`,
          [oType, existing[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO ownershipsong (song_id, ownership_id, ownership_type, status, is_delete)
           VALUES (?, ?, ?, 1, 0)`,
          [sId, id, oType]
        );
      }
    }

    res.json({ message: 'Songs added to ownership document successfully' });
  } catch (error) {
    console.error('Error adding songs to ownership document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /ownership/:id
exports.updateOwnership = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ownership ID' });
    }

    let docName = extractDocName(req);

    // Fallback: If docName is empty in request body/query, retrieve existing document_name from DB
    if (!docName) {
      const [existingDoc] = await pool.query(
        `SELECT document_name FROM ownership WHERE id = ? AND is_delete = 0`,
        [id]
      );
      if (existingDoc.length > 0 && existingDoc[0].document_name) {
        docName = existingDoc[0].document_name;
      }
    }

    if (!docName) {
      docName = 'Ownership Document';
    }

    const docTag = req.body.document_tag !== undefined ? req.body.document_tag : (req.body.tags || '');
    const isOwn = req.body.is_ownership !== undefined ? (req.body.is_ownership == 1 || req.body.is_ownership === true || req.body.is_ownership === 'true' ? 1 : 0) : 1;
    
    let docUrl = req.body.document_url !== undefined ? req.body.document_url : '';
    const uploadedFile = extractUploadedFile(req);
    if (uploadedFile) {
      docUrl = `/uploads/documents/${uploadedFile.filename}`;
    }

    if (docUrl) {
      await pool.query(
        `UPDATE ownership 
         SET document_name = ?, document_tag = ?, is_ownership = ?, document_url = ?
         WHERE id = ? AND is_delete = 0`,
        [docName, docTag, isOwn, docUrl, id]
      );
    } else {
      await pool.query(
        `UPDATE ownership 
         SET document_name = ?, document_tag = ?, is_ownership = ?
         WHERE id = ? AND is_delete = 0`,
        [docName, docTag, isOwn, id]
      );
    }

    const songsList = parseSongsList(req.body);
    if (songsList.length > 0 || req.body.songs !== undefined || req.body.song_ids !== undefined) {
      const unassigned = songsList.filter(s => !s.ownership_type || !String(s.ownership_type).trim());
      if (unassigned.length > 0) {
        return res.status(400).json({ message: 'Ownership type is mandatory for each selected song.' });
      }

      await pool.query(
        `UPDATE ownershipsong SET status = 0, is_delete = 1 WHERE ownership_id = ?`,
        [id]
      );

      for (const songObj of songsList) {
        const [existing] = await pool.query(
          `SELECT id FROM ownershipsong WHERE ownership_id = ? AND song_id = ?`,
          [id, songObj.song_id]
        );

        if (existing.length > 0) {
          await pool.query(
            `UPDATE ownershipsong SET ownership_type = ?, status = 1, is_delete = 0 WHERE id = ?`,
            [songObj.ownership_type, existing[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO ownershipsong (song_id, ownership_id, ownership_type, status, is_delete) VALUES (?, ?, ?, 1, 0)`,
            [songObj.song_id, id, songObj.ownership_type]
          );
        }
      }
    }

    res.json({ message: 'Ownership document updated successfully' });
  } catch (error) {
    console.error('Error updating ownership document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /ownership/:id
exports.deleteOwnership = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ownership ID' });
    }

    await pool.query(
      `UPDATE ownership SET status = 0, is_delete = 1 WHERE id = ?`,
      [id]
    );

    await pool.query(
      `UPDATE ownershipsong SET status = 0, is_delete = 1 WHERE ownership_id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [id]
    );

    res.json({ success: true, message: 'Ownership document deleted successfully', id });
  } catch (error) {
    console.error('Error deleting ownership document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
