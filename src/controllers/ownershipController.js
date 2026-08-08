const { getPool } = require('../config/db');
const { createAuditLog } = require('../utils/auditLogger');

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

function formatDocumentUrl(pathStr, host) {
  if (!pathStr || typeof pathStr !== 'string') {
    return `${host}/uploads/documents/sample-document.pdf`;
  }
  const cleanPath = pathStr.replace(/\\/g, '/').trim();
  if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
    return cleanPath;
  }
  if (cleanPath.startsWith('/uploads/')) {
    return `${host}${cleanPath}`;
  }
  if (cleanPath.startsWith('uploads/')) {
    return `${host}/${cleanPath}`;
  }
  return `${host}/uploads/documents/sample-document.pdf`;
}

async function fetchSongConflictsMap(songIds, pool) {
  if (!songIds || songIds.length === 0) return {};
  const placeholders = songIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT SongId, COUNT(*) as cCount
     FROM SongConflict 
     WHERE SongId IN (${placeholders}) AND Status = 1 AND (IsDeleted = 0 OR IsDeleted IS NULL)
     GROUP BY SongId`,
    songIds
  );
  const map = {};
  rows.forEach(r => {
    map[r.SongId] = r.cCount;
  });
  return map;
}

async function syncSongOwnership(pool, songIds) {
  if (!songIds || (Array.isArray(songIds) && songIds.length === 0)) return;
  const songIdList = Array.isArray(songIds) ? songIds.filter(Boolean) : [songIds];
  if (songIdList.length === 0) return;

  for (const songId of songIdList) {
    const [rows] = await pool.query(
      `SELECT 
         MAX(os.is_singer) as is_singer,
         MAX(os.is_lyrics) as is_lyrics,
         MAX(os.is_musician) as is_musician,
         MAX(os.is_recordlabel) as is_recordlabel
       FROM ownershipsong os
       JOIN ownership o ON os.ownership_id = o.id 
         AND (o.is_delete = 0 OR o.is_delete IS NULL) 
         AND (o.status = 1 OR o.status IS NULL) 
         AND o.is_ownership = 1
       WHERE os.song_id = ? AND (os.status = 1 OR os.status IS NULL) AND (os.is_delete = 0 OR os.is_delete IS NULL)`,
      [songId]
    );

    const r = rows[0] || {};
    const isSinger = r.is_singer === 1 ? 1 : 0;
    const isLyrics = r.is_lyrics === 1 ? 1 : 0;
    const isMusician = r.is_musician === 1 ? 1 : 0;
    const isRecordLabel = r.is_recordlabel === 1 ? 1 : 0;

    await pool.query(
      `UPDATE songs 
       SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ? 
       WHERE id = ?`,
      [isSinger, isLyrics, isMusician, isRecordLabel, songId]
    );
  }
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

function extractDocTagFlags(req) {
  const body = req.body || {};
  const query = req.query || {};

  let isSinger = body.is_singer == 1 || body.is_singer === true || query.is_singer == 1 ? 1 : 0;
  let isLyrics = body.is_lyrics == 1 || body.is_lyrics === true || query.is_lyrics == 1 ? 1 : 0;
  let isMusician = body.is_musician == 1 || body.is_musician === true || query.is_musician == 1 ? 1 : 0;
  let isRecordLabel = body.is_recordlabel == 1 || body.is_recordlabel === true || body.is_record_label == 1 || query.is_recordlabel == 1 ? 1 : 0;

  const tagInput = body.document_tag || body.tags || query.document_tag || query.tags || '';
  if (tagInput) {
    const str = String(tagInput).toLowerCase();
    if (str.includes('singer') || str.includes('sing')) isSinger = 1;
    if (str.includes('lyric')) isLyrics = 1;
    if (str.includes('music') || str.includes('melody')) isMusician = 1;
    if (str.includes('recode') || str.includes('record') || str.includes('label')) isRecordLabel = 1;
  }

  return {
    is_singer: isSinger,
    is_lyrics: isLyrics,
    is_musician: isMusician,
    is_recordlabel: isRecordLabel
  };
}

function buildTagString(r) {
  if (!r) return '';
  const tagsList = [];
  if (r.is_singer == 1 || r.is_singer === true) tagsList.push('Singer');
  if (r.is_lyrics == 1 || r.is_lyrics === true) tagsList.push('Lyrics');
  if (r.is_musician == 1 || r.is_musician === true) tagsList.push('Musician');
  if (r.is_recordlabel == 1 || r.is_recordlabel === true || r.is_record_label == 1) tagsList.push('Record Label');
  return tagsList.join(', ');
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

// Automatically recalculate and synchronize ownership flags on songs table
async function syncSongOwnership(pool, songIds) {
  if (!Array.isArray(songIds) || songIds.length === 0) return;

  const cleanSongIds = [...new Set(songIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0))];
  if (cleanSongIds.length === 0) return;

  try {
    // Query active ownership mappings for affected songs
    const [calcRows] = await pool.query(`
      SELECT 
        os.song_id,
        MAX(os.is_singer) AS is_singer,
        MAX(os.is_lyrics) AS is_lyrics,
        MAX(os.is_musician) AS is_musician,
        MAX(os.is_recordlabel) AS is_recordlabel
      FROM ownershipsong os
      JOIN ownership o ON os.ownership_id = o.id
      WHERE os.song_id IN (?) AND os.status = 1 AND os.is_delete = 0 AND o.status = 1 AND o.is_delete = 0
      GROUP BY os.song_id
    `, [cleanSongIds]);

    const calcMap = {};
    calcRows.forEach(row => {
      calcMap[row.song_id] = {
        is_singer: row.is_singer === 1 ? 1 : 0,
        is_lyrics: row.is_lyrics === 1 ? 1 : 0,
        is_musician: row.is_musician === 1 ? 1 : 0,
        is_recordlabel: row.is_recordlabel === 1 ? 1 : 0
      };
    });

    // Update songs table for every affected song, keeping the ownership % column in sync
    for (const sId of cleanSongIds) {
      const flags = calcMap[sId] || { is_singer: 0, is_lyrics: 0, is_musician: 0, is_recordlabel: 0 };
      const ownershipPct = (flags.is_recordlabel ? 50 : 0) + (flags.is_lyrics ? 25 : 0) + (flags.is_musician ? 25 : 0);
      await pool.query(
        `UPDATE songs SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ?, ownership = ? WHERE id = ?`,
        [flags.is_singer, flags.is_lyrics, flags.is_musician, flags.is_recordlabel, ownershipPct, sId]
      );
    }
  } catch (err) {
    console.error('Error synchronizing song ownership:', err);
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

  const parseFlags = (item) => {
    if (!item || typeof item !== 'object') {
      return { is_singer: 0, is_lyrics: 0, is_musician: 0, is_recordlabel: 0 };
    }

    let isSinger = item.is_singer == 1 || item.is_singer === true ? 1 : 0;
    let isLyrics = item.is_lyrics == 1 || item.is_lyrics === true ? 1 : 0;
    let isMusician = item.is_musician == 1 || item.is_musician === true ? 1 : 0;
    let isRecordLabel = item.is_recordlabel == 1 || item.is_recordlabel === true || item.is_record_label == 1 || item.is_record_label === true ? 1 : 0;

    const typesArr = item.ownership_types || item.ownershipTypes || item.types;
    if (Array.isArray(typesArr)) {
      typesArr.forEach(t => {
        const str = String(t).toLowerCase();
        if (str.includes('singer') || str.includes('sing')) isSinger = 1;
        if (str.includes('lyric')) isLyrics = 1;
        if (str.includes('music') || str.includes('melody')) isMusician = 1;
        if (str.includes('recode') || str.includes('record') || str.includes('label')) isRecordLabel = 1;
      });
    }

    if (item.ownership_type || item.ownershipType) {
      const str = String(item.ownership_type || item.ownershipType).toLowerCase();
      if (str.includes('singer') || str.includes('sing')) isSinger = 1;
      if (str.includes('lyric')) isLyrics = 1;
      if (str.includes('music') || str.includes('melody')) isMusician = 1;
      if (str.includes('recode') || str.includes('record') || str.includes('label')) isRecordLabel = 1;
    }

    return {
      is_singer: isSinger,
      is_lyrics: isLyrics,
      is_musician: isMusician,
      is_recordlabel: isRecordLabel
    };
  };

  if (Array.isArray(songs)) {
    return songs.map(item => {
      if (typeof item === 'object' && item !== null) {
        const sId = parseInt(item.id || item.song_id || item.value, 10);
        const flags = parseFlags(item);
        return { song_id: sId, ...flags };
      }
      return { song_id: parseInt(item, 10), is_singer: 0, is_lyrics: 0, is_musician: 0, is_recordlabel: 0 };
    }).filter(s => !isNaN(s.song_id));
  } else if (Array.isArray(song_ids)) {
    let typesMap = body.song_ownership_types || body.song_ownership_flags || {};
    if (typeof typesMap === 'string') {
      try { typesMap = JSON.parse(typesMap); } catch (e) { typesMap = {}; }
    }
    return song_ids.map(sId => {
      const idInt = parseInt(sId, 10);
      const val = typesMap[sId] || typesMap[idInt] || {};
      const flags = parseFlags(val);
      return { song_id: idInt, ...flags };
    }).filter(s => !isNaN(s.song_id));
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
        o.is_singer,
        o.is_lyrics,
        o.is_musician,
        o.is_recordlabel,
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

    // 1. Fetch song count metrics for active songs (status = 1 AND is_delete = 0)
    const [songSummaryRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 100 THEN 1 ELSE 0 END), 0) AS songCount100,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 75 THEN 1 ELSE 0 END), 0) AS songCount75,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 50 THEN 1 ELSE 0 END), 0) AS songCount50,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 25 THEN 1 ELSE 0 END), 0) AS songCount25,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 0 THEN 1 ELSE 0 END), 0) AS songCountNeutral
      FROM songs
      WHERE status = 1 AND (is_delete = 0 OR is_delete IS NULL)
    `);

    // 2. Fetch document count metrics for active ownership documents (is_ownership = 1 AND status = 1 AND is_delete = 0)
    const [docSummaryRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 100 THEN 1 ELSE 0 END), 0) AS docCount100,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 75 THEN 1 ELSE 0 END), 0) AS docCount75,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 50 THEN 1 ELSE 0 END), 0) AS docCount50,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 25 THEN 1 ELSE 0 END), 0) AS docCount25,
        COALESCE(SUM(CASE WHEN (COALESCE(is_recordlabel, 0)*50 + COALESCE(is_lyrics, 0)*25 + COALESCE(is_musician, 0)*25) = 0 THEN 1 ELSE 0 END), 0) AS docCountNeutral
      FROM ownership
      WHERE is_ownership = 1 AND status = 1 AND (is_delete = 0 OR is_delete IS NULL)
    `);

    const sRow = songSummaryRows[0] || {};
    const dRow = docSummaryRows[0] || {};

    const summaryData = {
      songCount100: Number(sRow.songCount100 || 0),
      docCount100: Number(dRow.docCount100 || 0),
      songCount75: Number(sRow.songCount75 || 0),
      docCount75: Number(dRow.docCount75 || 0),
      songCount50: Number(sRow.songCount50 || 0),
      docCount50: Number(dRow.docCount50 || 0),
      songCount25: Number(sRow.songCount25 || 0),
      docCount25: Number(dRow.docCount25 || 0),
      songCountNeutral: Number(sRow.songCountNeutral || 0),
      docCountNeutral: Number(dRow.docCountNeutral || 0)
    };

    const formattedList = rows.map(r => {
      const docFile = r.document_url || '/uploads/documents/sample-document.pdf';
      const formattedDocUrl = formatImage(docFile, host);
      const tagStr = buildTagString(r);
      return {
        id: r.id,
        name: r.document_name,
        document_name: r.document_name,
        is_singer: r.is_singer === 1,
        is_lyrics: r.is_lyrics === 1,
        is_musician: r.is_musician === 1,
        is_recordlabel: r.is_recordlabel === 1,
        document_tag: tagStr,
        tags: tagStr,
        is_ownership: r.is_ownership === 1,
        addToOwnership: r.is_ownership === 1 ? 'Yes' : 'No',
        songCount: r.songCount || 0,
        ownershipFor: tagStr || '—',
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
      summary: summaryData,
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

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || req.query.keyword || '';
    const isExport = req.query.export === 'true';

    const baseSongQuery = `
      SELECT s.id, s.name, s.nameSinhala, s.status, s.notes, s.conflict,
             os.is_singer, os.is_lyrics, os.is_musician, os.is_recordlabel,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songSinger ss JOIN artists art ON ss.artist_id = art.id WHERE ss.song_id = s.id AND (art.is_delete = 0 OR art.is_delete IS NULL)) as singerNames,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songLyrics sl JOIN artists art ON sl.artist_id = art.id WHERE sl.song_id = s.id AND (art.is_delete = 0 OR art.is_delete IS NULL)) as lyricistNames,
             (SELECT GROUP_CONCAT(art.name SEPARATOR ', ') FROM songmusician sm JOIN artists art ON sm.artist_id = art.id WHERE sm.song_id = s.id AND (art.is_delete = 0 OR art.is_delete IS NULL)) as musicianNames
      FROM ownershipsong os
      JOIN songs s ON os.song_id = s.id
      WHERE os.ownership_id = ? AND os.status = 1 AND os.is_delete = 0 AND (s.is_delete = 0 OR s.is_delete IS NULL)
    `;

    let finalSongQuery = `SELECT * FROM (${baseSongQuery}) as song_list`;
    let songQueryParams = [id];

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      finalSongQuery += ` WHERE (name LIKE ? OR nameSinhala LIKE ? OR singerNames LIKE ? OR lyricistNames LIKE ? OR musicianNames LIKE ?)`;
      songQueryParams.push(term, term, term, term, term);
    }

    // Total songs count for pagination
    const [songCountRows] = await pool.query(
      `SELECT COUNT(*) as total FROM (${finalSongQuery}) as sub`,
      songQueryParams
    );
    const totalSongCount = songCountRows.length > 0 ? songCountRows[0].total : 0;
    const totalSongPages = Math.ceil(totalSongCount / limit) || 1;

    let dataQuery = finalSongQuery + ` ORDER BY id ASC`;
    let songRows;

    if (isExport) {
      [songRows] = await pool.query(dataQuery, songQueryParams);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [songRows] = await pool.query(dataQuery, [...songQueryParams, limit, offset]);
    }

    const host = `${req.protocol}://${req.get('host')}`;
    const songIds = songRows.map(s => s.id);
    const [songLabelsMap, songConflictsMap, songNotesCasesMap] = await Promise.all([
      fetchSongLabelsMap(songIds, pool, host),
      fetchSongConflictsMap(songIds, pool),
      fetchSongNotesCasesMap(songRows, pool)
    ]);

    const songOwnershipFlagsMap = {};
    songRows.forEach(s => {
      songOwnershipFlagsMap[s.id] = {
        is_singer: s.is_singer === 1 ? 1 : 0,
        is_lyrics: s.is_lyrics === 1 ? 1 : 0,
        is_musician: s.is_musician === 1 ? 1 : 0,
        is_recordlabel: s.is_recordlabel === 1 ? 1 : 0
      };
    });

    const formattedDocUrl = formatDocumentUrl(r.document_url, host);
    const tagStr = buildTagString(r);

    res.json({
      id: r.id,
      name: r.document_name,
      document_name: r.document_name,
      is_singer: r.is_singer === 1,
      is_lyrics: r.is_lyrics === 1,
      is_musician: r.is_musician === 1,
      is_recordlabel: r.is_recordlabel === 1,
      document_tag: tagStr,
      tags: tagStr,
      is_ownership: r.is_ownership === 1,
      addToOwnership: r.is_ownership === 1 ? 'Yes' : 'No',
      songCount: r.songCount || 0,
      ownershipFor: tagStr || '—',
      document_url: formattedDocUrl,
      documentUrl: formattedDocUrl,
      currentPage: page,
      totalPages: totalSongPages,
      totalRecords: totalSongCount,
      song_ids: songRows.map(s => String(s.id)),
      song_ownership_types: songOwnershipFlagsMap,
      song_ownership_flags: songOwnershipFlagsMap,
      songs: songRows.map(s => {
        const labelsList = songLabelsMap[s.id] || [];
        const cCount = songConflictsMap[s.id] || 0;
        const isSinger = s.is_singer === 1;
        const isLyrics = s.is_lyrics === 1;
        const isMusician = s.is_musician === 1;
        const isRecordLabel = s.is_recordlabel === 1;

        const typesList = [];
        if (isSinger) typesList.push('Singer');
        if (isLyrics) typesList.push('Lyrics');
        if (isMusician) typesList.push('Musician');
        if (isRecordLabel) typesList.push('Record Label');

        const pct = (isRecordLabel ? 25 : 0) + (isLyrics ? 25 : 0) + (isMusician ? 25 : 0) + (isSinger ? 25 : 0);
        const statusStr = (s.status === 1 || s.status === '1' || s.status === 'Active' || s.status === 'active') ? 'Active' : 'Inactive';
        const conflictStr = cCount > 0 ? `${cCount} Conflict${cCount > 1 ? 's' : ''}` : (s.conflict && s.conflict !== '0' && s.conflict !== 'No' ? s.conflict : 'No');

        return {
          id: s.id,
          name: s.nameSinhala ? `${toTitleCase(s.nameSinhala)} (${toTitleCase(s.name)})` : toTitleCase(s.name),
          rawName: s.name,
          nameSinhala: s.nameSinhala,
          status: statusStr,
          artist: toTitleCase(s.singerNames) || 'Singer',
          artistSub: 'Duo - Second Artist',
          lyrics: toTitleCase(s.lyricistNames) || '—',
          music: toTitleCase(s.musicianNames) || '—',
          labels: labelsList,
          recordLabels: labelsList,
          notes: songNotesCasesMap[s.id] || s.notes || 'No Cases Or Notes',
          conflictCount: cCount,
          conflict: conflictStr,
          conflicts: conflictStr,
          is_singer: isSinger ? 1 : 0,
          is_lyrics: isLyrics ? 1 : 0,
          is_musician: isMusician ? 1 : 0,
          is_recordlabel: isRecordLabel ? 1 : 0,
          ownershipTypes: typesList,
          ownershipType: typesList.join(', ') || '—',
          ownership: pct,
          ownershipPercentage: pct,
          ownershipPercentageText: `${pct}%`,
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

    const unassigned = songsList.filter(s => !s.is_singer && !s.is_lyrics && !s.is_musician && !s.is_recordlabel);
    if (unassigned.length > 0) {
      return res.status(400).json({ message: 'At least one ownership type is mandatory for each selected song.' });
    }

    const tagFlags = extractDocTagFlags(req);
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
      `INSERT INTO ownership (document_name, is_singer, is_lyrics, is_musician, is_recordlabel, is_ownership, document_url, status, is_delete)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      [docName, tagFlags.is_singer, tagFlags.is_lyrics, tagFlags.is_musician, tagFlags.is_recordlabel, isOwn, docUrl]
    );

    const ownershipId = result.insertId;

    for (const songObj of songsList) {
      await pool.query(
        `INSERT INTO ownershipsong (song_id, ownership_id, is_singer, is_lyrics, is_musician, is_recordlabel, status, is_delete)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
        [songObj.song_id, ownershipId, songObj.is_singer, songObj.is_lyrics, songObj.is_musician, songObj.is_recordlabel]
      );
    }

    // Synchronize affected songs in songs table
    await syncSongOwnership(pool, songsList.map(s => s.song_id));

    await createAuditLog({
      user: req.user || null,
      action: 'CREATE_OWNERSHIP',
      details: `Created ownership document ${docName}`
    });

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
    const { song_id } = req.body;

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
      const isSinger = req.body.is_singer == 1 || req.body.is_singer === true ? 1 : 0;
      const isLyrics = req.body.is_lyrics == 1 || req.body.is_lyrics === true ? 1 : 0;
      const isMusician = req.body.is_musician == 1 || req.body.is_musician === true ? 1 : 0;
      const isRecordLabel = req.body.is_recordlabel == 1 || req.body.is_recordlabel === true || req.body.is_record_label == 1 || req.body.is_record_label === true ? 1 : 0;

      songsList.push({
        song_id: parseInt(song_id, 10),
        is_singer: isSinger,
        is_lyrics: isLyrics,
        is_musician: isMusician,
        is_recordlabel: isRecordLabel
      });
    }

    if (songsList.length === 0) {
      return res.status(400).json({ message: 'Please select at least one song to add' });
    }

    const unassigned = songsList.filter(s => !s.is_singer && !s.is_lyrics && !s.is_musician && !s.is_recordlabel);
    if (unassigned.length > 0) {
      return res.status(400).json({ message: 'At least one ownership type is mandatory for each selected song.' });
    }

    for (const songObj of songsList) {
      const sId = songObj.song_id;

      const [existing] = await pool.query(
        `SELECT id FROM ownershipsong WHERE ownership_id = ? AND song_id = ?`,
        [id, sId]
      );

      if (existing.length > 0) {
        await pool.query(
          `UPDATE ownershipsong SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ?, status = 1, is_delete = 0 WHERE id = ?`,
          [songObj.is_singer, songObj.is_lyrics, songObj.is_musician, songObj.is_recordlabel, existing[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO ownershipsong (song_id, ownership_id, is_singer, is_lyrics, is_musician, is_recordlabel, status, is_delete)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
          [sId, id, songObj.is_singer, songObj.is_lyrics, songObj.is_musician, songObj.is_recordlabel]
        );
      }
    }

    // Synchronize affected songs in songs table
    await syncSongOwnership(pool, songsList.map(s => s.song_id));

    await createAuditLog({
      user: req.user || null,
      action: 'UPDATE_OWNERSHIP',
      details: `Added songs to ownership document ${id}`
    });

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

    const tagFlags = extractDocTagFlags(req);
    const isOwn = req.body.is_ownership !== undefined ? (req.body.is_ownership == 1 || req.body.is_ownership === true || req.body.is_ownership === 'true' ? 1 : 0) : 1;
    
    let docUrl = req.body.document_url !== undefined ? req.body.document_url : '';
    const uploadedFile = extractUploadedFile(req);
    if (uploadedFile) {
      docUrl = `/uploads/documents/${uploadedFile.filename}`;
    }

    if (docUrl) {
      await pool.query(
        `UPDATE ownership 
         SET document_name = ?, is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ?, is_ownership = ?, document_url = ?
         WHERE id = ? AND is_delete = 0`,
        [docName, tagFlags.is_singer, tagFlags.is_lyrics, tagFlags.is_musician, tagFlags.is_recordlabel, isOwn, docUrl, id]
      );
    } else {
      await pool.query(
        `UPDATE ownership 
         SET document_name = ?, is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ?, is_ownership = ?
         WHERE id = ? AND is_delete = 0`,
        [docName, tagFlags.is_singer, tagFlags.is_lyrics, tagFlags.is_musician, tagFlags.is_recordlabel, isOwn, id]
      );
    }

    // Fetch existing active song IDs linked to this ownership document before update
    const [existingSongRows] = await pool.query(
      `SELECT song_id FROM ownershipsong WHERE ownership_id = ? AND status = 1 AND is_delete = 0`,
      [id]
    );
    const oldSongIds = existingSongRows.map(r => r.song_id);

    const songsList = parseSongsList(req.body);
    if (songsList.length > 0 || req.body.songs !== undefined || req.body.song_ids !== undefined) {
      const unassigned = songsList.filter(s => !s.is_singer && !s.is_lyrics && !s.is_musician && !s.is_recordlabel);
      if (unassigned.length > 0) {
        return res.status(400).json({ message: 'At least one ownership type is mandatory for each selected song.' });
      }

      const newSongIds = songsList.map(s => s.song_id);
      const removedSongIds = oldSongIds.filter(sId => !newSongIds.includes(sId));

      // Soft delete relationship records for removed songs (status = 0, is_delete = 1)
      if (removedSongIds.length > 0) {
        await pool.query(
          `UPDATE ownershipsong SET status = 0, is_delete = 1 WHERE ownership_id = ? AND song_id IN (?)`,
          [id, removedSongIds]
        );
      }

      // Insert or Update remaining / new song relationship records
      for (const songObj of songsList) {
        const [existing] = await pool.query(
          `SELECT id FROM ownershipsong WHERE ownership_id = ? AND song_id = ?`,
          [id, songObj.song_id]
        );

        if (existing.length > 0) {
          await pool.query(
            `UPDATE ownershipsong SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ?, status = 1, is_delete = 0 WHERE id = ?`,
            [songObj.is_singer, songObj.is_lyrics, songObj.is_musician, songObj.is_recordlabel, existing[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO ownershipsong (song_id, ownership_id, is_singer, is_lyrics, is_musician, is_recordlabel, status, is_delete) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
            [songObj.song_id, id, songObj.is_singer, songObj.is_lyrics, songObj.is_musician, songObj.is_recordlabel]
          );
        }
      }

      // Recalculate song flags for all affected song IDs
      const allAffectedSongIds = [...oldSongIds, ...newSongIds];
      await syncSongOwnership(pool, allAffectedSongIds);
    }

    await createAuditLog({
      user: req.user || null,
      action: 'UPDATE_OWNERSHIP',
      details: `Updated ownership document ${docName}`
    });

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

    // Fetch linked song IDs before soft deletion for synchronization
    const [linkedSongs] = await pool.query(
      `SELECT song_id FROM ownershipsong WHERE ownership_id = ? AND status = 1 AND is_delete = 0`,
      [id]
    );
    const songIdsToSync = linkedSongs.map(r => r.song_id);

    await pool.query(
      `UPDATE ownership SET status = 0, is_delete = 1 WHERE id = ?`,
      [id]
    );

    await pool.query(
      `UPDATE ownershipsong SET status = 0, is_delete = 1 WHERE ownership_id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [id]
    );

    // Synchronize songs table
    await syncSongOwnership(pool, songIdsToSync);

    await createAuditLog({
      user: req.user || null,
      action: 'DELETE_OWNERSHIP',
      details: `Deleted ownership document ID ${id}`
    });

    res.json({ success: true, message: 'Ownership document deleted successfully', id });
  } catch (error) {
    console.error('Error deleting ownership document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /ownership/:id/songs/:songId
exports.removeSongFromOwnership = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const songId = parseInt(req.params.songId, 10);

    if (isNaN(id) || isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid ownership ID or song ID' });
    }

    await pool.query(
      `UPDATE ownershipsong SET status = 0, is_delete = 1 WHERE ownership_id = ? AND song_id = ?`,
      [id, songId]
    );

    // Synchronize songs table boolean flags for this song
    await syncSongOwnership(pool, [songId]);

    await createAuditLog({
      user: req.user || null,
      action: 'REMOVE_OWNERSHIP_SONG',
      details: `Removed song ${songId} from ownership document ${id}`
    });

    res.json({ success: true, message: 'Song removed from ownership document successfully' });
  } catch (error) {
    console.error('Error removing song from ownership document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.syncSongOwnership = syncSongOwnership;
