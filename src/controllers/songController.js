const { getPool } = require('../config/db');
const { createAuditLog } = require('../utils/auditLogger');

function getSriLankaTimestamp() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const slTime = new Date(utc + (3600000 * 5.5));
  const pad = (num) => String(num).padStart(2, '0');
  return `${slTime.getFullYear()}-${pad(slTime.getMonth() + 1)}-${pad(slTime.getDate())} ${pad(slTime.getHours())}:${pad(slTime.getMinutes())}:${pad(slTime.getSeconds())}`;
}

// Helper to convert string to Title Case (capitalizing the first letter of each word)
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

function formatImage(pathStr, host) {
  if (!pathStr) return null;
  if (pathStr.startsWith('http://') || pathStr.startsWith('https://') || pathStr.startsWith('data:')) return pathStr;
  const cleanPath = pathStr.replace(/\\/g, '/');
  return cleanPath.startsWith('/') ? `${host}${cleanPath}` : `${host}/${cleanPath}`;
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
        const formattedImg = formatImage(rel.label_image, host);
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

// Get all songs
exports.getSongs = async (req, res) => {
  try {
    const pool = getPool();
    
    // Parse query parameters
    const page = req.query.page ? parseInt(req.query.page, 10) : null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const offset = page ? (page - 1) * limit : 0;
    const isExport = req.query.export === 'true';
    
    const search = req.query.search || '';
    const versionType = req.query.versionType || '';
    const statusFilter = req.query.status || '';
    const conflictFilter = req.query.conflict || '';
    const ownershipFilter = req.query.ownership || '';
    const sort = req.query.sort || 'Songs A-Z';
    const excludeId = req.query.excludeId ? parseInt(req.query.excludeId, 10) : null;
    
    // Build WHERE clauses - always exclude soft-deleted songs
    let whereClauses = ['(songs.is_delete = 0 OR songs.is_delete IS NULL)'];
    let queryParams = [];
    
    if (search) {
      whereClauses.push(
        `(songs.name LIKE ? OR songs.nameSinhala LIKE ? 
          OR EXISTS (SELECT 1 FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = songs.id AND a.name LIKE ?)
          OR EXISTS (SELECT 1 FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = songs.id AND a.name LIKE ?)
          OR EXISTS (SELECT 1 FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = songs.id AND a.name LIKE ?))`
      );
      const searchPattern = `%${search}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    if (versionType) {
      whereClauses.push('songs.versionType = ?');
      queryParams.push(versionType);
    }

    if (statusFilter !== undefined && statusFilter !== null && statusFilter !== '') {
      whereClauses.push('songs.status = ?');
      if (statusFilter === 'Active' || String(statusFilter) === '1') {
        queryParams.push(1);
      } else if (statusFilter === 'Inactive' || String(statusFilter) === '0') {
        queryParams.push(0);
      } else {
        queryParams.push(statusFilter);
      }
    }

    if (conflictFilter !== undefined && conflictFilter !== null && conflictFilter !== '') {
      const isConflictYes = ['1', 1, 'yes', 'true'].includes(
        typeof conflictFilter === 'string' ? conflictFilter.toLowerCase() : conflictFilter
      );
      whereClauses.push('songs.conflict = ?');
      queryParams.push(isConflictYes ? 'Yes' : 'No');
    }

    // songs.ownership is kept in sync with is_recordlabel/is_lyrics/is_musician via syncSongOwnership()
    if (ownershipFilter) {
      if (ownershipFilter === 'High') {
        whereClauses.push('songs.ownership >= 50');
      } else {
        whereClauses.push('songs.ownership < 50');
      }
    }

    if (excludeId) {
      whereClauses.push('songs.id != ?');
      queryParams.push(excludeId);
    }
    
    const whereClauseStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    
    // Fetch total count if paginated
    let totalCount = 0;
    if (page && !isExport) {
      const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM songs ${whereClauseStr}`, queryParams);
      totalCount = countRows[0].total;
    }
    
    // Sorting order
    let orderClause = 'ORDER BY songs.name ASC'; // Default to alphabetical order
    if (sort === 'Artists A-Z') {
      orderClause = 'ORDER BY (SELECT a.name FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = songs.id LIMIT 1) ASC';
    } else if (sort === 'Recently Added') {
      orderClause = 'ORDER BY songs.created_at DESC, songs.id DESC';
    }
    
    // Fetch records
    let dataQuery = `SELECT * FROM songs ${whereClauseStr} ${orderClause}`;
    let queryParamsForData = [...queryParams];
    if (page && !isExport) {
      dataQuery += ' LIMIT ? OFFSET ?';
      queryParamsForData.push(limit, offset);
    }
    
    const [songs] = await pool.query(dataQuery, queryParamsForData);
    if (songs.length === 0) {
      return res.json((page && !isExport) ? { songs: [], totalCount: 0 } : []);
    }

    const songIds = songs.map((s) => s.id);
    const host = `${req.protocol}://${req.get('host')}`;

    // 2-3.5 Fetch all secondary song data in parallel - these queries are all keyed
    // off songIds/songs independently of each other, so there's no need to wait on them one by one.
    const [relations, distRelations, ringRelations, labelRelations, songConflictsMap, songNotesCasesMap] = await Promise.all([
      pool.query(`
        SELECT ss.song_id, 'singer' as role, a.id as artist_id, a.name as artist_name 
        FROM songSinger ss 
        JOIN artists a ON ss.artist_id = a.id 
        WHERE ss.song_id IN (?)
        UNION ALL
        SELECT sl.song_id, 'lyricist' as role, a.id as artist_id, a.name as artist_name 
        FROM songLyrics sl 
        JOIN artists a ON sl.artist_id = a.id 
        WHERE sl.song_id IN (?)
        UNION ALL
        SELECT sm.song_id, 'musician' as role, a.id as artist_id, a.name as artist_name 
        FROM songmusician sm 
        JOIN artists a ON sm.artist_id = a.id 
        WHERE sm.song_id IN (?)
      `, [songIds, songIds, songIds]).then(([rows]) => rows),
      pool.query(`
        SELECT sd.song_id, sd.distributor_id, d.company_name
        FROM songdistributor sd
        JOIN distributors d ON sd.distributor_id = d.id AND (d.is_deleted = 0 OR d.is_deleted IS NULL)
        WHERE sd.song_id IN (?) AND (sd.status = 1 OR sd.status IS NULL) AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL)
      `, [songIds]).then(([rows]) => rows),
      pool.query(`
        SELECT sr.song_id, sr.ringintone_id, r.name, sr.ringtone_code, sr.content_code, sr.added_date
        FROM songringintone sr
        JOIN ringintone r ON sr.ringintone_id = r.id
        WHERE sr.song_id IN (?) AND sr.status = 1
      `, [songIds]).then(([rows]) => rows),
      pool.query(`
        SELECT sa.song_id, rl.id as label_id, COALESCE(rl.display_name, rl.name) as label_name, rl.image_url as label_image
        FROM songalbum sa
        JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
        JOIN record_label rl ON a.record_label_id = rl.id 
          AND (rl.status = 1 OR rl.status IS NULL) 
          AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
        WHERE sa.song_id IN (?) AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
      `, [songIds]).then(([rows]) => rows),
      fetchSongConflictsMap(songIds, pool),
      fetchSongNotesCasesMap(songs, pool)
    ]);

    // 3. Group relationships by song_id
    const songRelations = {};
    relations.forEach((rel) => {
      if (!songRelations[rel.song_id]) {
        songRelations[rel.song_id] = { singers: [], lyricists: [], musicians: [] };
      }
      if (rel.role === 'singer') {
        songRelations[rel.song_id].singers.push(rel.artist_name);
      } else if (rel.role === 'lyricist') {
        songRelations[rel.song_id].lyricists.push(rel.artist_name);
      } else if (rel.role === 'musician') {
        songRelations[rel.song_id].musicians.push(rel.artist_name);
      }
    });

    const songDistributors = {};
    distRelations.forEach((rel) => {
      songDistributors[rel.song_id] = { id: rel.distributor_id, name: toTitleCase(rel.company_name) };
    });

    const songRingtones = {};
    ringRelations.forEach((rel) => {
      songRingtones[rel.song_id] = {
        id: rel.ringintone_id,
        name: toTitleCase(rel.name),
        ringtone_code: rel.ringtone_code,
        content_code: rel.content_code,
        added_date: rel.added_date
      };
    });

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

    // 4. Map songs to the shape expected by the frontend
    const formattedSongs = songs.map((song) => {
      const rels = songRelations[song.id] || { singers: [], lyricists: [], musicians: [] };
      const dist = songDistributors[song.id] || null;
      const ring = songRingtones[song.id] || null;
      const labelList = songLabels[song.id] || [];
      const labelsText = labelList.map(l => l.name).join(', ') || 'None';
      const cCount = songConflictsMap[song.id] || 0;
      const conflictText = cCount > 0 ? 'Yes' : 'No';

      const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1') ? 50 : 0;
      const isLyr = (song.is_lyrics === 1 || song.is_lyrics === true || song.is_lyrics === '1') ? 25 : 0;
      const isMus = (song.is_musician === 1 || song.is_musician === true || song.is_musician === '1') ? 25 : 0;
      const calculatedPct = isRec + isLyr + isMus;

      return {
        id: song.id,
        name: toTitleCase(song.name), // Format song name to Title Case on fetch
        nameSinhala: song.nameSinhala,
        status: (song.status === 1 || song.status === true || song.status === '1') ? 'Active' : 'Inactive',
        artist: rels.singers.length > 0 ? rels.singers.join(', ') : 'None',
        artistSub: rels.singers.length > 1 ? 'Due - Second Artist' : '',
        lyrics: rels.lyricists.length > 0 ? rels.lyricists.join(', ') : 'None',
        music: rels.musicians.length > 0 ? rels.musicians.join(', ') : 'None',
        labels: labelList,
        recordLabels: labelList,
        labelNames: labelsText,
        ownership: calculatedPct,
        ownershipPercentage: calculatedPct,
        ownershipPercentageText: `${calculatedPct}%`,
        notes: songNotesCasesMap[song.id] || song.notes || 'No Cases Or Notes',
        conflictCount: cCount,
        conflicts: conflictText,
        conflict: conflictText,
        versionType: song.versionType || 'Original',
        versionName: song.versionName,
        originalSongId: song.originalSongId,
        isrcCode: song.isrcCode,
        distributionProvider: dist ? dist.name : null,
        distributorId: dist ? String(dist.id) : null,
        ringtoneProvider: ring ? ring.name : null,
        ringtoneId: ring ? ring.ringtone_code : null,
        contentCode: ring ? ring.content_code : null,
        addedDate: ring && ring.added_date ? ring.added_date.toISOString().split('T')[0] : null,
        ringintoneId: ring ? String(ring.id) : null,
        trackUrl: song.trackUrl ? (song.trackUrl.startsWith('http') ? song.trackUrl : `${host}${song.trackUrl}`) : null,
        imageUrl: song.imageUrl ? (song.imageUrl.startsWith('http') ? song.imageUrl : `${host}${song.imageUrl}`) : null,
        createdAt: song.created_at,
      };
    });

    if (page && !isExport) {
      res.json({ songs: formattedSongs, totalCount });
    } else {
      res.json(formattedSongs);
    }
  } catch (error) {
    console.error('Error fetching songs:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// Create new song
exports.createSong = async (req, res) => {
  try {
    const pool = getPool();
    const { name, nameSinhala, versionType, isrcCode, other } = req.body;

    if (!name || !nameSinhala) {
      return res.status(400).json({ message: 'Song name and Sinhala name are required' });
    }

    if (!isrcCode || !isrcCode.trim()) {
      return res.status(400).json({ message: 'ISRC Code is required' });
    }

    // Verify ISRC uniqueness
    const [existingIsrc] = await pool.query('SELECT id FROM songs WHERE isrcCode = ?', [isrcCode.trim()]);
    if (existingIsrc.length > 0) {
      return res.status(400).json({ message: 'ISRC Code already exists. It must be unique.' });
    }

    // Verify uploaded files
    const trackFile = req.files && req.files['track'] ? req.files['track'][0] : null;
    const artFile = req.files && req.files['art'] ? req.files['art'][0] : null;

    if (!trackFile) {
      return res.status(400).json({ message: 'Song track (MP3) is required' });
    }

    const trackUrl = `/uploads/audio/${trackFile.filename}`;
    const imageUrl = artFile ? `/uploads/images/${artFile.filename}` : null;

    // Helper to extract array of IDs
    const getArrayInput = (field) => {
      if (!field) return [];
      if (Array.isArray(field)) return field;
      try {
        return String(field).split(',').map(s => s.trim()).filter(Boolean);
      } catch (e) {
        return [field];
      }
    };

    const singers = getArrayInput(req.body.artists || req.body['artists[]'] || req.body['artists']);
    const lyricists = getArrayInput(req.body.lyrics || req.body['lyrics[]'] || req.body['lyrics']);
    const musicians = getArrayInput(req.body.music || req.body['music[]'] || req.body['music']);

    let versionName = null;
    let originalSongId = null;
    if (versionType === 'Version' && req.body.versionDetails) {
      try {
        const details = typeof req.body.versionDetails === 'string' ? JSON.parse(req.body.versionDetails) : req.body.versionDetails;
        versionName = details.versionName;
        originalSongId = details.originalSong && !isNaN(details.originalSong) ? parseInt(details.originalSong, 10) : null;
      } catch (e) {
        console.warn('Failed to parse versionDetails:', e.message);
      }
    }

    // Insert Song - Save name in simple letters (lowercase)
    // ownership starts at 0 (no is_recordlabel/is_lyrics/is_musician flags yet) and is
    // recalculated by syncSongOwnership() once ownership documents are linked to the song.
    const lowercaseName = name.trim().toLowerCase();
    const [songResult] = await pool.query(
      `INSERT INTO songs (
        name, nameSinhala, status, trackUrl, imageUrl, isrcCode, other, 
        versionType, versionName, originalSongId, ownership, notes, conflict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'No Cases Or Notes', 'No')`,
      [
        lowercaseName,
        nameSinhala,
        1, // Active (true)
        trackUrl,
        imageUrl,
        isrcCode.trim(),
        other || '',
        versionType || 'Original',
        versionName,
        originalSongId
      ]
    );

    const songId = songResult.insertId;

    // Insert artist relations with main artist tracking
    const insertRelations = async (artistList, role, mainArtistId) => {
      let tableName = 'songSinger';
      if (role === 'lyricist') tableName = 'songLyrics';
      else if (role === 'musician') tableName = 'songmusician';

      if (!Array.isArray(artistList) || artistList.length === 0) return;

      const itemsToInsert = [];
      for (const item of artistList) {
        let idVal = item;
        let isMain = false;
        if (typeof item === 'object' && item !== null) {
          idVal = item.id || item.value;
          isMain = !!item.isMain;
        }
        let artistId = parseInt(idVal, 10);
        if (isNaN(artistId)) {
          const [artist] = await pool.query('SELECT id FROM artists WHERE name = ? OR artist_code = ?', [idVal, idVal]);
          if (artist.length > 0) artistId = artist[0].id;
          else continue;
        }
        if (mainArtistId && String(artistId) === String(mainArtistId)) {
          isMain = true;
        }
        itemsToInsert.push({ artistId, isMain });
      }

      if (itemsToInsert.length === 0) return;

      // If no item is marked as main, default the first item to is_main = 1
      if (!itemsToInsert.some(i => i.isMain)) {
        itemsToInsert[0].isMain = true;
      }

      for (const item of itemsToInsert) {
        await pool.query(
          `INSERT INTO ${tableName} (song_id, artist_id, is_main, status, is_delete) 
           VALUES (?, ?, ?, 1, 0) 
           ON DUPLICATE KEY UPDATE is_main = VALUES(is_main), status = 1, is_delete = 0`,
          [songId, item.artistId, item.isMain ? 1 : 0]
        );
      }
    };

    await insertRelations(singers, 'singer', req.body.mainSinger || req.body.mainSingerId);
    await insertRelations(lyricists, 'lyricist', req.body.mainLyricist || req.body.mainLyricistId);
    await insertRelations(musicians, 'musician', req.body.mainMusician || req.body.mainMusicianId);

    // Auto-update artist role flags: if an artist is used in a role but their column is 0, set it to 1
    const updateArtistRoleFlags = async (artistList, column) => {
      for (const item of artistList) {
        let idVal = typeof item === 'object' && item !== null ? (item.id || item.value) : item;
        const artistId = parseInt(idVal, 10);
        if (!isNaN(artistId)) {
          await pool.query(`UPDATE artists SET ${column} = 1 WHERE id = ? AND ${column} != 1`, [artistId]);
        }
      }
    };
    await updateArtistRoleFlags(singers, 'singer');
    await updateArtistRoleFlags(lyricists, 'lyrics');
    await updateArtistRoleFlags(musicians, 'music');


    let distributorId = null;
    let distributionProvider = null;
    if (req.body.distribution) {
      try {
        const dist = typeof req.body.distribution === 'string' ? JSON.parse(req.body.distribution) : req.body.distribution;
        distributorId = dist.provider && !isNaN(dist.provider) ? parseInt(dist.provider, 10) : null;
      } catch (e) {
        console.warn('Failed to parse distribution:', e.message);
      }
    }

    if (distributorId) {
      await pool.query('UPDATE songdistributor SET status = 0, updated_date = NOW() WHERE song_id = ?', [songId]);
      await pool.query(
        'INSERT INTO songdistributor (song_id, distributor_id, status, updated_date) VALUES (?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE status = 1, updated_date = NOW()',
        [songId, distributorId]
      );
      const [distNameRows] = await pool.query('SELECT company_name FROM distributors WHERE id = ?', [distributorId]);
      if (distNameRows.length > 0) {
        distributionProvider = toTitleCase(distNameRows[0].company_name);
      }
    }

    // 2. Save ringtone mappings (multiple)
    let savedRingtones = [];
    if (req.body.ringtones) {
      try {
        const rtArray = typeof req.body.ringtones === 'string' ? JSON.parse(req.body.ringtones) : req.body.ringtones;
        if (Array.isArray(rtArray) && rtArray.length > 0) {
          // Validate: each entry must have provider, ringtoneCode, contentCode
          for (let i = 0; i < rtArray.length; i++) {
            const entry = rtArray[i];
            if (!entry.provider || isNaN(entry.provider)) {
              return res.status(400).json({ message: `Ringtone entry ${i + 1}: Provider is required` });
            }
            if (!entry.ringtoneCode || !entry.ringtoneCode.trim()) {
              return res.status(400).json({ message: `Ringtone entry ${i + 1}: Ringtone Code is required` });
            }
            if (!entry.contentCode || !entry.contentCode.trim()) {
              return res.status(400).json({ message: `Ringtone entry ${i + 1}: Content Code is required` });
            }
          }

          // Check for duplicate providers
          const providerIds = rtArray.map(r => parseInt(r.provider, 10));
          const uniqueProviders = new Set(providerIds);
          if (uniqueProviders.size !== providerIds.length) {
            return res.status(400).json({ message: 'Duplicate ringtone providers are not allowed. Each provider can only be added once.' });
          }

          // Deactivate any existing and insert all
          await pool.query('UPDATE songringintone SET status = 0 WHERE song_id = ?', [songId]);
          const slTimestamp = getSriLankaTimestamp();

          for (const entry of rtArray) {
            const providerId = parseInt(entry.provider, 10);
            await pool.query(
              `INSERT INTO songringintone (song_id, ringintone_id, status, ringtone_code, content_code, added_date) 
               VALUES (?, ?, 1, ?, ?, ?)
               ON DUPLICATE KEY UPDATE status = 1, ringtone_code = ?, content_code = ?, added_date = ?`,
              [songId, providerId, entry.ringtoneCode.trim(), entry.contentCode.trim(), slTimestamp, entry.ringtoneCode.trim(), entry.contentCode.trim(), slTimestamp]
            );
            const [ringNameRows] = await pool.query('SELECT name FROM ringintone WHERE id = ?', [providerId]);
            savedRingtones.push({
              ringintoneId: String(providerId),
              ringtoneProvider: ringNameRows.length > 0 ? toTitleCase(ringNameRows[0].name) : null,
              ringtoneCode: entry.ringtoneCode.trim(),
              contentCode: entry.contentCode.trim(),
              addedDate: slTimestamp
            });
          }
        }
      } catch (e) {
        if (e.message && e.message.includes('Ringtone entry')) throw e;
        console.warn('Failed to parse ringtones:', e.message);
      }
    }

    const getArtistDetailsByRole = async (tableName) => {
      const [artists] = await pool.query(`
        SELECT t.artist_id, a.name, COALESCE(t.is_main, 0) as is_main
        FROM ${tableName} t 
        JOIN artists a ON t.artist_id = a.id 
        WHERE t.song_id = ?
      `, [songId]);
      return artists;
    };

    const singersData = await getArtistDetailsByRole('songSinger');
    const lyricistsData = await getArtistDetailsByRole('songLyrics');
    const musiciansData = await getArtistDetailsByRole('songmusician');

    const mainSingerObj = singersData.find(s => s.is_main === 1) || singersData[0];
    const mainLyricistObj = lyricistsData.find(l => l.is_main === 1) || lyricistsData[0];
    const mainMusicianObj = musiciansData.find(m => m.is_main === 1) || musiciansData[0];

    const host = `${req.protocol}://${req.get('host')}`;

    // Backward compat: first ringtone entry as flat fields
    const firstRing = savedRingtones.length > 0 ? savedRingtones[0] : null;

    await createAuditLog({
      user: req.user || null,
      action: 'CREATE_SONG',
      details: `Created song ${lowercaseName}`
    });

    res.status(201).json({
      id: songId,
      name: toTitleCase(lowercaseName),
      nameSinhala,
      status: 'Active',
      artist: singersData.length > 0 ? singersData.map(s => s.name).join(', ') : 'None',
      artistSub: singersData.length > 1 ? 'Due - Second Artist' : '',
      lyrics: lyricistsData.length > 0 ? lyricistsData.map(l => l.name).join(', ') : 'None',
      music: musiciansData.length > 0 ? musiciansData.map(m => m.name).join(', ') : 'None',
      ownership: 100,
      notes: 'No Cases Or Notes',
      conflict: 'No',
      versionType: versionType || 'Original',
      versionName,
      originalSongId,
      isrcCode,
      other: other || '',
      distributionProvider,
      distributorId: distributorId ? String(distributorId) : null,
      ringtoneProvider: firstRing ? firstRing.ringtoneProvider : null,
      ringtoneId: firstRing ? firstRing.ringtoneCode : null,
      contentCode: firstRing ? firstRing.contentCode : null,
      addedDate: firstRing ? firstRing.addedDate : null,
      ringintoneId: firstRing ? firstRing.ringintoneId : null,
      ringtones: savedRingtones,
      trackUrl: `${host}${trackUrl}`,
      imageUrl: imageUrl ? `${host}${imageUrl}` : null,
      singers: singersData.map(s => String(s.artist_id)),
      lyricists: lyricistsData.map(l => String(l.artist_id)),
      musicians: musiciansData.map(m => String(m.artist_id)),
      mainSingerId: mainSingerObj ? String(mainSingerObj.artist_id) : null,
      mainLyricistId: mainLyricistObj ? String(mainLyricistObj.artist_id) : null,
      mainMusicianId: mainMusicianObj ? String(mainMusicianObj.artist_id) : null,
      singersList: singersData.map(s => ({ id: String(s.artist_id), name: s.name, isMain: s.is_main === 1 })),
      lyricistsList: lyricistsData.map(l => ({ id: String(l.artist_id), name: l.name, isMain: l.is_main === 1 })),
      musiciansList: musiciansData.map(m => ({ id: String(m.artist_id), name: m.name, isMain: m.is_main === 1 })),
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('Error creating song:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// Check if a song name already exists (case-insensitive)
exports.checkSongName = async (req, res) => {
  try {
    const pool = getPool();
    const name = (req.body.name || '').trim().toLowerCase();
    const excludeId = req.body.excludeId ? parseInt(req.body.excludeId, 10) : null;

    if (!name) {
      return res.status(400).json({ message: 'Song name is required' });
    }

    let query = 'SELECT id FROM songs WHERE LOWER(name) = ? AND (is_delete = 0 OR is_delete IS NULL)';
    let params = [name];
    if (excludeId) {
      query += ' AND id != ?';
      params.push(excludeId);
    }

    const [songs] = await pool.query(query, params);
    
    if (songs.length > 0) {
      return res.json({ exists: true });
    }
    
    res.json({ exists: false });
  } catch (error) {
    console.error('Error checking song name:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// Get a single song by ID
exports.getSongById = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    const [songs] = await pool.query('SELECT * FROM songs WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)', [songId]);
    if (songs.length === 0) {
      return res.status(404).json({ message: 'Song not found' });
    }
    const song = songs[0];

    // Fetch singer, lyricist, musician relations with is_main flag
    const [singers] = await pool.query(`
      SELECT ss.artist_id, a.name, COALESCE(ss.is_main, 0) as is_main
      FROM songSinger ss 
      JOIN artists a ON ss.artist_id = a.id 
      WHERE ss.song_id = ?
    `, [songId]);
    
    const [lyricists] = await pool.query(`
      SELECT sl.artist_id, a.name, COALESCE(sl.is_main, 0) as is_main
      FROM songLyrics sl 
      JOIN artists a ON sl.artist_id = a.id 
      WHERE sl.song_id = ?
    `, [songId]);
    
    const [musicians] = await pool.query(`
      SELECT sm.artist_id, a.name, COALESCE(sm.is_main, 0) as is_main
      FROM songmusician sm 
      JOIN artists a ON sm.artist_id = a.id 
      WHERE sm.song_id = ?
    `, [songId]);

    // Fetch active distributor
    const [distRows] = await pool.query(`
      SELECT sd.distributor_id, d.company_name
      FROM songdistributor sd
      JOIN distributors d ON sd.distributor_id = d.id
      WHERE sd.song_id = ? AND sd.status = 1
    `, [songId]);
    const activeDist = distRows[0] || null;

    // Fetch active ringtones (multiple)
    const [ringRows] = await pool.query(`
      SELECT sr.ringintone_id, r.name, sr.ringtone_code, sr.content_code, sr.added_date
      FROM songringintone sr
      JOIN ringintone r ON sr.ringintone_id = r.id
      WHERE sr.song_id = ? AND sr.status = 1
    `, [songId]);

    const ringtones = ringRows.map(ring => ({
      ringintoneId: String(ring.ringintone_id),
      ringtoneProvider: toTitleCase(ring.name),
      ringtoneCode: ring.ringtone_code || '',
      contentCode: ring.content_code || '',
      addedDate: ring.added_date ? (typeof ring.added_date === 'object' ? ring.added_date.toISOString().split('T')[0] : String(ring.added_date).split('T')[0]) : null
    }));

    // Backward compat: first ringtone entry as flat fields
    const activeRing = ringRows[0] || null;

    // Fetch active record labels (from songalbum->album->record_label)
    const host = `${req.protocol}://${req.get('host')}`;
    const [labelRows] = await pool.query(`
      SELECT DISTINCT rl.id, COALESCE(rl.display_name, rl.name) as label_name, rl.image_url as label_image
      FROM songalbum sa
      JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
      JOIN record_label rl ON a.record_label_id = rl.id 
        AND (rl.status = 1 OR rl.status IS NULL) 
        AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
      WHERE sa.song_id = ? AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
    `, [songId]);

    const labelList = labelRows.map(r => {
      const img = r.label_image;
      const formattedImg = img ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`) : null;
      return {
        id: r.id,
        name: toTitleCase(r.label_name),
        imageUrl: formattedImg,
        image_url: formattedImg
      };
    });
    const labelsText = labelList.map(l => l.name).join(', ') || 'None';

    const mainSingerObj = singers.find(s => s.is_main === 1) || singers[0];
    const mainLyricistObj = lyricists.find(l => l.is_main === 1) || lyricists[0];
    const mainMusicianObj = musicians.find(m => m.is_main === 1) || musicians[0];

    res.json({
      id: song.id,
      name: toTitleCase(song.name), // Title Case song name on fetch
      nameSinhala: song.nameSinhala,
      status: (song.status === 1 || song.status === true || song.status === '1') ? 'Active' : 'Inactive',
      isrcCode: song.isrcCode,
      other: song.other,
      versionType: song.versionType,
      versionName: song.versionName,
      originalSongId: song.originalSongId,
      distributionProvider: activeDist ? toTitleCase(activeDist.company_name) : null,
      distributorId: activeDist ? String(activeDist.distributor_id) : null,
      ringtoneProvider: activeRing ? activeRing.name : null,
      ringtoneId: activeRing ? activeRing.ringtone_code : null,
      contentCode: activeRing ? activeRing.content_code : null,
      addedDate: activeRing && activeRing.added_date ? (typeof activeRing.added_date === 'object' ? activeRing.added_date.toISOString().split('T')[0] : String(activeRing.added_date).split('T')[0]) : null,
      ringintoneId: activeRing ? String(activeRing.ringintone_id) : null,
      ringtones,
      labels: labelList,
      recordLabels: labelList,
      labelNames: labelsText,
      trackUrl: song.trackUrl ? (song.trackUrl.startsWith('http') ? song.trackUrl : `${host}${song.trackUrl}`) : null,
      imageUrl: song.imageUrl ? (song.imageUrl.startsWith('http') ? song.imageUrl : `${host}${song.imageUrl}`) : null,
      singers: singers.map(s => String(s.artist_id)),
      lyricists: lyricists.map(l => String(l.artist_id)),
      musicians: musicians.map(m => String(m.artist_id)),
      mainSingerId: mainSingerObj ? String(mainSingerObj.artist_id) : null,
      mainLyricistId: mainLyricistObj ? String(mainLyricistObj.artist_id) : null,
      mainMusicianId: mainMusicianObj ? String(mainMusicianObj.artist_id) : null,
      singersList: singers.map(s => ({ id: String(s.artist_id), name: s.name, isMain: s.is_main === 1 })),
      lyricistsList: lyricists.map(l => ({ id: String(l.artist_id), name: l.name, isMain: l.is_main === 1 })),
      musiciansList: musicians.map(m => ({ id: String(m.artist_id), name: m.name, isMain: m.is_main === 1 })),
      artist: singers.length > 0 ? singers.map(s => s.name).join(', ') : 'None',
      lyrics: lyricists.length > 0 ? lyricists.map(l => l.name).join(', ') : 'None',
      music: musicians.length > 0 ? musicians.map(m => m.name).join(', ') : 'None',
    });
  } catch (error) {
    console.error('Error fetching song by ID:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// Update existing song
exports.updateSong = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // Check if song exists
    const [existingSongs] = await pool.query('SELECT * FROM songs WHERE id = ?', [songId]);
    if (existingSongs.length === 0) {
      return res.status(404).json({ message: 'Song not found' });
    }
    const currentSong = existingSongs[0];

    // Save song name as simple letters (lowercase)
    const name = (req.body.name || currentSong.name).trim().toLowerCase();
    const nameSinhala = (req.body.nameSinhala || currentSong.nameSinhala).trim();
    const isrcCode = req.body.isrcCode !== undefined ? req.body.isrcCode.trim() : currentSong.isrcCode;
    const other = req.body.other !== undefined ? req.body.other.trim() : currentSong.other;
    const versionType = req.body.versionType !== undefined ? req.body.versionType : currentSong.versionType;

    if (!isrcCode) {
      return res.status(400).json({ message: 'ISRC Code is required' });
    }

    // Verify ISRC uniqueness
    const [existingIsrc] = await pool.query('SELECT id FROM songs WHERE isrcCode = ? AND id != ?', [isrcCode, songId]);
    if (existingIsrc.length > 0) {
      return res.status(400).json({ message: 'ISRC Code already exists. It must be unique.' });
    }

    const trackFile = req.files && req.files['track'] ? req.files['track'][0] : null;
    const artFile = req.files && req.files['art'] ? req.files['art'][0] : null;

    let trackUrl = currentSong.trackUrl;
    if (trackFile) {
      trackUrl = `/uploads/audio/${trackFile.filename}`;
    }
    let imageUrl = currentSong.imageUrl;
    if (artFile) {
      imageUrl = `/uploads/images/${artFile.filename}`;
    }

    let versionName = currentSong.versionName;
    let originalSongId = currentSong.originalSongId;
    if (versionType !== 'Version') {
      versionName = null;
      originalSongId = null;
    } else if (req.body.versionDetails) {
      try {
        const details = typeof req.body.versionDetails === 'string' ? JSON.parse(req.body.versionDetails) : req.body.versionDetails;
        versionName = details.versionName;
        originalSongId = details.originalSong && !isNaN(details.originalSong) ? parseInt(details.originalSong, 10) : null;
      } catch (e) {
        console.warn('Failed to parse versionDetails:', e.message);
      }
    }

    // Parse role arrays
    let singers = [];
    let lyricists = [];
    let musicians = [];
    try {
      singers = req.body.artists ? (typeof req.body.artists === 'string' ? JSON.parse(req.body.artists) : req.body.artists) : [];
      lyricists = req.body.lyrics ? (typeof req.body.lyrics === 'string' ? JSON.parse(req.body.lyrics) : req.body.lyrics) : [];
      musicians = req.body.music ? (typeof req.body.music === 'string' ? JSON.parse(req.body.music) : req.body.music) : [];
    } catch (e) {
      console.warn('Failed to parse relation fields:', e.message);
    }

    // Execute UPDATE query
    await pool.query(
      `UPDATE songs SET 
        name = ?, nameSinhala = ?, trackUrl = ?, imageUrl = ?, isrcCode = ?, other = ?, 
        versionType = ?, versionName = ?, originalSongId = ?
      WHERE id = ?`,
      [
        name,
        nameSinhala,
        trackUrl,
        imageUrl,
        isrcCode,
        other,
        versionType,
        versionName,
        originalSongId,
        songId
      ]
    );

    // Rebuild artist relationships
    await pool.query('DELETE FROM songSinger WHERE song_id = ?', [songId]);
    await pool.query('DELETE FROM songLyrics WHERE song_id = ?', [songId]);
    await pool.query('DELETE FROM songmusician WHERE song_id = ?', [songId]);

    const insertRelations = async (artistList, tableName, mainArtistId) => {
      if (!Array.isArray(artistList) || artistList.length === 0) return;

      const itemsToInsert = [];
      for (const item of artistList) {
        let idVal = item;
        let isMain = false;
        if (typeof item === 'object' && item !== null) {
          idVal = item.id || item.value;
          isMain = !!item.isMain;
        }
        let artistId = parseInt(idVal, 10);
        if (isNaN(artistId)) {
          const [artist] = await pool.query('SELECT id FROM artists WHERE name = ? OR artist_code = ?', [idVal, idVal]);
          if (artist.length > 0) artistId = artist[0].id;
          else continue;
        }
        if (mainArtistId && String(artistId) === String(mainArtistId)) {
          isMain = true;
        }
        itemsToInsert.push({ artistId, isMain });
      }

      if (itemsToInsert.length === 0) return;

      // If no item is marked as main, default the first item to is_main = 1
      if (!itemsToInsert.some(i => i.isMain)) {
        itemsToInsert[0].isMain = true;
      }

      for (const item of itemsToInsert) {
        await pool.query(
          `INSERT INTO ${tableName} (song_id, artist_id, is_main, status, is_delete) 
           VALUES (?, ?, ?, 1, 0) 
           ON DUPLICATE KEY UPDATE is_main = VALUES(is_main), status = 1, is_delete = 0`,
          [songId, item.artistId, item.isMain ? 1 : 0]
        );
      }
    };

    if (Array.isArray(singers)) await insertRelations(singers, 'songSinger', req.body.mainSinger || req.body.mainSingerId);
    if (Array.isArray(lyricists)) await insertRelations(lyricists, 'songLyrics', req.body.mainLyricist || req.body.mainLyricistId);
    if (Array.isArray(musicians)) await insertRelations(musicians, 'songmusician', req.body.mainMusician || req.body.mainMusicianId);

    // Auto-update artist role flags: if an artist is used in a role but their column is 0, set it to 1
    const updateArtistRoleFlags = async (artistList, column) => {
      for (const item of artistList) {
        let idVal = typeof item === 'object' && item !== null ? (item.id || item.value) : item;
        const artistId = parseInt(idVal, 10);
        if (!isNaN(artistId)) {
          await pool.query(`UPDATE artists SET ${column} = 1 WHERE id = ? AND ${column} != 1`, [artistId]);
        }
      }
    };
    if (Array.isArray(singers)) await updateArtistRoleFlags(singers, 'singer');
    if (Array.isArray(lyricists)) await updateArtistRoleFlags(lyricists, 'lyrics');
    if (Array.isArray(musicians)) await updateArtistRoleFlags(musicians, 'music');

    // 3. Save distributor mapping
    let distributorId = null;
    let distributionProvider = null;
    if (req.body.distribution) {
      try {
        const dist = typeof req.body.distribution === 'string' ? JSON.parse(req.body.distribution) : req.body.distribution;
        distributorId = dist ? (dist.provider && !isNaN(dist.provider) ? parseInt(dist.provider, 10) : null) : null;
      } catch (e) {
        console.warn('Failed to parse distribution:', e.message);
      }
    }

    if (distributorId) {
      await pool.query('UPDATE songdistributor SET status = 0, updated_date = NOW() WHERE song_id = ?', [songId]);
      await pool.query(
        'INSERT INTO songdistributor (song_id, distributor_id, status, updated_date) VALUES (?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE status = 1, updated_date = NOW()',
        [songId, distributorId]
      );
      const [distNameRows] = await pool.query('SELECT company_name FROM distributors WHERE id = ?', [distributorId]);
      if (distNameRows.length > 0) {
        distributionProvider = toTitleCase(distNameRows[0].company_name);
      }
    } else if (req.body.distribution === null || req.body.distribution === 'null') {
      await pool.query('UPDATE songdistributor SET status = 0, updated_date = NOW() WHERE song_id = ?', [songId]);
    }

    // 4. Save ringtone mappings (multiple)
    let savedRingtones = [];
    if (req.body.ringtones) {
      try {
        const rtArray = typeof req.body.ringtones === 'string' ? JSON.parse(req.body.ringtones) : req.body.ringtones;
        if (Array.isArray(rtArray) && rtArray.length > 0) {
          // Validate: each entry must have provider, ringtoneCode, contentCode
          for (let i = 0; i < rtArray.length; i++) {
            const entry = rtArray[i];
            if (!entry.provider || isNaN(entry.provider)) {
              return res.status(400).json({ message: `Ringtone entry ${i + 1}: Provider is required` });
            }
            if (!entry.ringtoneCode || !entry.ringtoneCode.trim()) {
              return res.status(400).json({ message: `Ringtone entry ${i + 1}: Ringtone Code is required` });
            }
            if (!entry.contentCode || !entry.contentCode.trim()) {
              return res.status(400).json({ message: `Ringtone entry ${i + 1}: Content Code is required` });
            }
          }

          // Check for duplicate providers
          const providerIds = rtArray.map(r => parseInt(r.provider, 10));
          const uniqueProviders = new Set(providerIds);
          if (uniqueProviders.size !== providerIds.length) {
            return res.status(400).json({ message: 'Duplicate ringtone providers are not allowed. Each provider can only be added once.' });
          }

          // Deactivate all existing and insert all new
          await pool.query('UPDATE songringintone SET status = 0 WHERE song_id = ?', [songId]);
          const slTimestamp = getSriLankaTimestamp();

          for (const entry of rtArray) {
            const providerId = parseInt(entry.provider, 10);
            await pool.query(
              `INSERT INTO songringintone (song_id, ringintone_id, status, ringtone_code, content_code, added_date) 
               VALUES (?, ?, 1, ?, ?, ?)
               ON DUPLICATE KEY UPDATE status = 1, ringtone_code = ?, content_code = ?, added_date = ?`,
              [songId, providerId, entry.ringtoneCode.trim(), entry.contentCode.trim(), slTimestamp, entry.ringtoneCode.trim(), entry.contentCode.trim(), slTimestamp]
            );
            const [ringNameRows] = await pool.query('SELECT name FROM ringintone WHERE id = ?', [providerId]);
            savedRingtones.push({
              ringintoneId: String(providerId),
              ringtoneProvider: ringNameRows.length > 0 ? toTitleCase(ringNameRows[0].name) : null,
              ringtoneCode: entry.ringtoneCode.trim(),
              contentCode: entry.contentCode.trim(),
              addedDate: slTimestamp
            });
          }
        }
      } catch (e) {
        if (e.message && e.message.includes('Ringtone entry')) throw e;
        console.warn('Failed to parse ringtones:', e.message);
      }
    } else if (req.body.ringtones === null || req.body.ringtones === 'null') {
      // Ringtone toggle was turned off — deactivate all
      await pool.query('UPDATE songringintone SET status = 0 WHERE song_id = ?', [songId]);
    }

    const getArtistDetailsByRole = async (tableName) => {
      const [artists] = await pool.query(`
        SELECT a.id, a.name, COALESCE(t.is_main, 0) as is_main FROM ${tableName} t 
        JOIN artists a ON t.artist_id = a.id 
        WHERE t.song_id = ?
      `, [songId]);
      return artists;
    };

    const singersData = await getArtistDetailsByRole('songSinger');
    const lyricistsData = await getArtistDetailsByRole('songLyrics');
    const musiciansData = await getArtistDetailsByRole('songmusician');

    const mainSingerObj = singersData.find(s => s.is_main === 1) || singersData[0];
    const mainLyricistObj = lyricistsData.find(l => l.is_main === 1) || lyricistsData[0];
    const mainMusicianObj = musiciansData.find(m => m.is_main === 1) || musiciansData[0];

    const host = `${req.protocol}://${req.get('host')}`;

    // Backward compat: first ringtone entry as flat fields
    const firstRing = savedRingtones.length > 0 ? savedRingtones[0] : null;

    await createAuditLog({
      user: req.user || null,
      action: 'UPDATE_SONG',
      details: `Updated song ${name}`
    });

    res.json({
      id: songId,
      name: toTitleCase(name),
      nameSinhala,
      status: (currentSong.status === 1 || currentSong.status === true || currentSong.status === '1') ? 'Active' : 'Inactive',
      artist: singersData.length > 0 ? singersData.map(s => s.name).join(', ') : 'None',
      artistSub: singersData.length > 1 ? 'Due - Second Artist' : '',
      lyrics: lyricistsData.length > 0 ? lyricistsData.map(l => l.name).join(', ') : 'None',
      music: musiciansData.length > 0 ? musiciansData.map(m => m.name).join(', ') : 'None',
      ownership: currentSong.ownership || 100,
      notes: currentSong.notes || 'No Cases Or Notes',
      conflict: currentSong.conflict || 'No',
      versionType: versionType || 'Original',
      versionName,
      originalSongId,
      isrcCode,
      other,
      distributionProvider,
      distributorId: distributorId ? String(distributorId) : null,
      ringtoneProvider: firstRing ? firstRing.ringtoneProvider : null,
      ringtoneId: firstRing ? firstRing.ringtoneCode : null,
      contentCode: firstRing ? firstRing.contentCode : null,
      addedDate: firstRing ? firstRing.addedDate : null,
      ringintoneId: firstRing ? firstRing.ringintoneId : null,
      ringtones: savedRingtones,
      trackUrl: trackUrl ? (trackUrl.startsWith('http') ? trackUrl : `${host}${trackUrl}`) : null,
      imageUrl: imageUrl ? (imageUrl.startsWith('http') ? imageUrl : `${host}${imageUrl}`) : null,
      singers: singersData.map(s => String(s.id)),
      lyricists: lyricistsData.map(l => String(l.id)),
      musicians: musiciansData.map(m => String(m.id)),
      mainSingerId: mainSingerObj ? String(mainSingerObj.id) : null,
      mainLyricistId: mainLyricistObj ? String(mainLyricistObj.id) : null,
      mainMusicianId: mainMusicianObj ? String(mainMusicianObj.id) : null,
      singersList: singersData.map(s => ({ id: String(s.id), name: s.name, isMain: s.is_main === 1 })),
      lyricistsList: lyricistsData.map(l => ({ id: String(l.id), name: l.name, isMain: l.is_main === 1 })),
      musiciansList: musiciansData.map(m => ({ id: String(m.id), name: m.name, isMain: m.is_main === 1 })),
    });
  } catch (error) {
    console.error('Error updating song:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// GET /songs/:id/distributions
// Returns ALL distributors linked to a song (active + inactive).
// isActive: true  → status = 1 (the one active distributor)
// isActive: false → status = 0 (previous / disabled ones)
// ─────────────────────────────────────────────────────────
exports.getSongDistributions = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    const [rows] = await pool.query(
      `SELECT
         sd.distributor_id,
         sd.status,
         sd.updated_date,
         d.company_name,
         d.email,
         d.outgoing_percentage
       FROM songdistributor sd
       JOIN distributors d ON sd.distributor_id = d.id
       WHERE sd.song_id = ?
       ORDER BY sd.status DESC, sd.distributor_id DESC`,
      [songId]
    );

    const distributions = rows.map((r) => {
      let changedAt = null;
      if (r.updated_date) {
        changedAt = typeof r.updated_date === 'object'
          ? r.updated_date.toISOString()
          : String(r.updated_date);
      }
      return {
        songDistributorId: `${songId}-${r.distributor_id}`,
        distributorId: r.distributor_id,
        company: toTitleCase(r.company_name),
        email: r.email || '',
        percentage: r.outgoing_percentage || 0,
        isActive: r.status === 1 || r.status === true || r.status === '1',
        changedAt,
      };
    });

    res.json({ distributions });
  } catch (error) {
    console.error('Error fetching song distributions:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// GET /songs/:id/ringtones
// Returns active ringtones only (status = 1).
// ─────────────────────────────────────────────────────────
exports.getSongRingtones = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    const [rows] = await pool.query(
      `SELECT
         CONCAT(sr.song_id, '-', sr.ringintone_id) AS songRingtoneId,
         sr.ringintone_id AS ringtoneId,
         sr.ringtone_code AS ringtoneCode,
         sr.content_code  AS contentCode,
         sr.added_date    AS addedDate,
         r.name           AS providerName,
         r.company_logo   AS companyLogo
       FROM songringintone sr
       JOIN ringintone r ON sr.ringintone_id = r.id
       WHERE sr.song_id = ? AND sr.status = 1 AND sr.is_deleted = 0
       ORDER BY sr.ringintone_id ASC`,
      [songId]
    );

    const host = `${req.protocol}://${req.get('host')}`;

    const ringtones = rows.map((r) => {
      const formatDate = (val) => {
        if (!val) return null;
        const str = typeof val === 'object' ? val.toISOString().split('T')[0] : String(val).split('T')[0];
        return str.replace(/-/g, '.');
      };
      return {
        songRingtoneId: r.songRingtoneId,
        ringtoneId: r.ringtoneId,
        providerName: toTitleCase(r.providerName),
        ringtoneCode: r.ringtoneCode || '',
        contentCode: r.contentCode || '',
        addedDate: formatDate(r.addedDate),
        lastUpdate: formatDate(r.addedDate), // updated_at not in schema; use added_date
        companyLogo: r.companyLogo ? (r.companyLogo.startsWith('http') ? r.companyLogo : `${host}${r.companyLogo}`) : null,
      };
    });

    res.json({ ringtones });
  } catch (error) {
    console.error('Error fetching song ringtones:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// PATCH /songs/:id/ringtones/:ringtoneId/remove
// Soft-deletes a song-ringtone link by setting status = 0.
// Does NOT delete the row.
// ─────────────────────────────────────────────────────────
exports.removeSongRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const ringtoneId = parseInt(req.params.ringtoneId, 10);

    if (isNaN(songId) || isNaN(ringtoneId)) {
      return res.status(400).json({ message: 'Invalid song ID or ringtone ID' });
    }

    const [result] = await pool.query(
      'UPDATE songringintone SET status = 0, is_deleted = 1 WHERE song_id = ? AND ringintone_id = ?',
      [songId, ringtoneId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Song ringtone record not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing song ringtone:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// GET /songs/:id/versions
// If the song is Original: returns all linked Version songs.
// If the song is a Version: returns an empty list.
// ─────────────────────────────────────────────────────────
exports.getSongVersions = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // Determine the type of the current song
    const [songRows] = await pool.query('SELECT versionType FROM songs WHERE id = ?', [songId]);
    if (songRows.length === 0) {
      return res.status(404).json({ message: 'Song not found' });
    }

    const versionType = songRows[0].versionType;

    // Version songs cannot have their own versions
    if (versionType !== 'Original') {
      return res.json({ versions: [] });
    }

    // Fetch all songs that are versions of this original
    const [versionSongs] = await pool.query(
      `SELECT * FROM songs WHERE originalSongId = ? AND versionType = 'Version' AND (is_delete = 0 OR is_delete IS NULL) ORDER BY id ASC`,
      [songId]
    );

    if (versionSongs.length === 0) {
      return res.json({ versions: [] });
    }

    const versionIds = versionSongs.map((s) => s.id);
    const host = `${req.protocol}://${req.get('host')}`;

    const [songLabelsMap, relations, songConflictsMap] = await Promise.all([
      fetchSongLabelsMap(versionIds, pool, host),
      pool.query(
        `SELECT ss.song_id, 'singer' AS role, a.name AS artist_name
           FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id IN (?)
         UNION ALL
         SELECT sl.song_id, 'lyricist' AS role, a.name AS artist_name
           FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id IN (?)
         UNION ALL
         SELECT sm.song_id, 'musician' AS role, a.name AS artist_name
           FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id IN (?)`,
        [versionIds, versionIds, versionIds]
      ).then(([rows]) => rows),
      fetchSongConflictsMap(versionIds, pool)
    ]);

    // Group relations by song_id
    const relMap = {};
    relations.forEach((rel) => {
      if (!relMap[rel.song_id]) relMap[rel.song_id] = { singers: [], lyricists: [], musicians: [] };
      if (rel.role === 'singer') relMap[rel.song_id].singers.push(rel.artist_name);
      else if (rel.role === 'lyricist') relMap[rel.song_id].lyricists.push(rel.artist_name);
      else if (rel.role === 'musician') relMap[rel.song_id].musicians.push(rel.artist_name);
    });


    const versions = versionSongs.map((s) => {
      const rels = relMap[s.id] || { singers: [], lyricists: [], musicians: [] };
      const parsedLabels = songLabelsMap[s.id] || [];
      const cCount = songConflictsMap[s.id] || 0;
      const conflictText = cCount > 0 ? 'Yes' : 'No';
      return {
        id: s.id,
        versionName: s.versionName || toTitleCase(s.name),
        parentSong: toTitleCase(s.name),
        status: (s.status === 1 || s.status === true || s.status === '1') ? 'Active' : 'Inactive',
        artist: rels.singers.length > 0 ? rels.singers.join(', ') : 'None',
        artistSub: rels.singers.length > 1 ? 'Due - Second Artist' : '',
        lyrics: rels.lyricists.length > 0 ? rels.lyricists.join(', ') : 'None',
        music: rels.musicians.length > 0 ? rels.musicians.join(', ') : 'None',
        labels: parsedLabels,
        recordLabels: parsedLabels,
        ownership: s.ownership || 100,
        notes: s.notes || 'No Cases Or Notes',
        conflictCount: cCount,
        conflicts: conflictText,
        conflict: conflictText,
      };
    });

    res.json({ versions });
  } catch (error) {
    console.error('Error fetching song versions:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// POST /songs/:id/ringtones
// Assigns/creates a new ringtone mapping for the song.
// ─────────────────────────────────────────────────────────
exports.addSongRingtone = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const { providerId, ringtoneCode, contentCode } = req.body;

    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }
    if (!providerId || isNaN(parseInt(providerId, 10))) {
      return res.status(400).json({ message: 'Provider ID is required' });
    }
    if (!ringtoneCode || !ringtoneCode.trim()) {
      return res.status(400).json({ message: 'Ringtone Code is required' });
    }
    if (!contentCode || !contentCode.trim()) {
      return res.status(400).json({ message: 'Content Code is required' });
    }

    const slTimestamp = getSriLankaTimestamp();

    await pool.query(
      `INSERT INTO songringintone (song_id, ringintone_id, status, ringtone_code, content_code, added_date)
       VALUES (?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = 1, ringtone_code = ?, content_code = ?, added_date = ?`,
      [
        songId,
        parseInt(providerId, 10),
        ringtoneCode.trim(),
        contentCode.trim(),
        slTimestamp,
        ringtoneCode.trim(),
        contentCode.trim(),
        slTimestamp,
      ]
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Error adding song ringtone:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// GET /songs/:id/conflicts
// Returns all non-deleted conflicts for the song.
// ─────────────────────────────────────────────────────────
exports.getSongConflicts = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    const [rows] = await pool.query(
      `SELECT * FROM SongConflict 
       WHERE SongId = ? AND IsDeleted = 0 
       ORDER BY Status DESC, ConflictDate DESC, Id DESC`,
      [songId]
    );

    const conflicts = rows.map((r) => ({
      id: r.Id,
      songId: r.SongId,
      copyrightConflict: r.CopyrightConflict,
      conflictOwner: toTitleCase(r.ConflictOwner), // Display formatted in Title Case
      conflictDate: r.ConflictDate ? (typeof r.ConflictDate === 'object' ? r.ConflictDate.toISOString().split('T')[0] : String(r.ConflictDate).split('T')[0]) : null,
      resolveDate: r.ResolveDate ? (typeof r.ResolveDate === 'object' ? r.ResolveDate.toISOString().split('T')[0] : String(r.ResolveDate).split('T')[0]) : null,
      status: r.Status,
    }));

    res.json({ conflicts });
  } catch (error) {
    console.error('Error fetching song conflicts:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// POST /songs/:id/conflicts
// Creates a new active conflict for the song.
// ─────────────────────────────────────────────────────────
exports.createSongConflict = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const { copyrightConflict, conflictOwner, conflictDate } = req.body;

    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }
    if (!copyrightConflict || !['Sound Records', 'Compositions'].includes(copyrightConflict)) {
      return res.status(400).json({ message: 'Invalid copyright conflict type' });
    }
    if (!conflictOwner || !conflictOwner.trim()) {
      return res.status(400).json({ message: 'Conflict Owner is required' });
    }
    if (!conflictDate) {
      return res.status(400).json({ message: 'Conflict Date is required' });
    }

    await pool.query(
      `INSERT INTO SongConflict (SongId, CopyrightConflict, ConflictOwner, ConflictDate, Status, IsDeleted)
       VALUES (?, ?, ?, ?, 1, 0)`,
      [songId, copyrightConflict, conflictOwner.trim(), conflictDate]
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Error creating song conflict:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// PATCH /songs/:id/conflicts/:conflictId/resolve
// Resolves an active conflict by setting Status = 0 and ResolveDate.
// ─────────────────────────────────────────────────────────
exports.resolveSongConflict = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const conflictId = parseInt(req.params.conflictId, 10);
    const { resolveDate } = req.body;

    if (isNaN(songId) || isNaN(conflictId)) {
      return res.status(400).json({ message: 'Invalid song ID or conflict ID' });
    }
    if (!resolveDate) {
      return res.status(400).json({ message: 'Resolve Date is required' });
    }

    await pool.query(
      `UPDATE SongConflict SET Status = 0, ResolveDate = ? 
       WHERE Id = ? AND SongId = ?`,
      [resolveDate, conflictId, songId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error resolving song conflict:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// PATCH /songs/:id/conflicts/:conflictId/delete
// Soft deletes a conflict by setting IsDeleted = 1.
// ─────────────────────────────────────────────────────────
exports.deleteSongConflict = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const conflictId = parseInt(req.params.conflictId, 10);

    if (isNaN(songId) || isNaN(conflictId)) {
      return res.status(400).json({ message: 'Invalid song ID or conflict ID' });
    }

    await pool.query(
      `UPDATE SongConflict SET IsDeleted = 1 
       WHERE Id = ? AND SongId = ?`,
      [conflictId, songId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting song conflict:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

function formatImage(pathStr, host) {
  if (!pathStr) return null;
  if (pathStr.startsWith('http://') || pathStr.startsWith('https://') || pathStr.startsWith('data:')) return pathStr;
  const cleanPath = pathStr.replace(/\\/g, '/');
  return cleanPath.startsWith('/') ? `${host}${cleanPath}` : `${host}/${cleanPath}`;
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

// ─────────────────────────────────────────────────────────
// GET /songs/:id/ownership
// Fetches song ownership summary & grouped ownership documents
// ─────────────────────────────────────────────────────────
exports.getSongOwnership = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const host = `${req.protocol}://${req.get('host')}`;

    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. Fetch song record boolean flags
    const [songRows] = await pool.query(
      `SELECT id, name, is_singer, is_lyrics, is_musician, is_recordlabel 
       FROM songs 
       WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [songId]
    );

    if (songRows.length === 0) {
      return res.status(404).json({ message: 'Song not found' });
    }

    const song = songRows[0];
    const isRecordLabel = song.is_recordlabel === 1;
    const isLyrics = song.is_lyrics === 1;
    const isMusician = song.is_musician === 1;
    const isSinger = song.is_singer === 1;

    // Summary Percentage: Record Label (50%), Lyrics (25%), Musician (25%)
    const pct = (isRecordLabel ? 50 : 0) + (isLyrics ? 25 : 0) + (isMusician ? 25 : 0);

    const summary = {
      percentage: pct,
      is_recordlabel: isRecordLabel,
      is_lyrics: isLyrics,
      is_musician: isMusician,
      is_singer: isSinger
    };

    // 2. Fetch linked ownershipsong mappings & ownership documents
    const [mappingRows] = await pool.query(
      `SELECT os.id as mapping_id, os.song_id, os.ownership_id,
              os.is_singer, os.is_lyrics, os.is_musician, os.is_recordlabel,
              o.document_name, o.document_url, o.is_ownership,
              o.is_singer as doc_is_singer, o.is_lyrics as doc_is_lyrics, o.is_musician as doc_is_musician, o.is_recordlabel as doc_is_recordlabel
       FROM ownershipsong os
       JOIN ownership o ON os.ownership_id = o.id 
         AND (o.status = 1 OR o.status IS NULL) 
         AND (o.is_delete = 0 OR o.is_delete IS NULL) 
         AND o.is_ownership = 1
       WHERE os.song_id = ? AND (os.status = 1 OR os.status IS NULL) AND (os.is_delete = 0 OR os.is_delete IS NULL)
       ORDER BY os.id ASC`,
      [songId]
    );

    // Fetch primary artist associated with each role for this song
    const [singers] = await pool.query(
      `SELECT a.name, a.image FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = ? AND (a.is_delete = 0 OR a.is_delete IS NULL) LIMIT 1`,
      [songId]
    );
    const [lyricists] = await pool.query(
      `SELECT a.name, a.image FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = ? AND (a.is_delete = 0 OR a.is_delete IS NULL) LIMIT 1`,
      [songId]
    );
    const [musicians] = await pool.query(
      `SELECT a.name, a.image FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = ? AND (a.is_delete = 0 OR a.is_delete IS NULL) LIMIT 1`,
      [songId]
    );
    const songLabelsMap = await fetchSongLabelsMap([songId], pool, host);
    const songLabelsList = songLabelsMap[songId] || [];

    const singerArtist = singers[0] ? { name: toTitleCase(singers[0].name), image: formatImage(singers[0].image, host), role: 'Singer' } : { name: 'Singer Artist', image: null, role: 'Singer' };
    const lyricistArtist = lyricists[0] ? { name: toTitleCase(lyricists[0].name), image: formatImage(lyricists[0].image, host), role: 'Lyrics' } : { name: 'Lyrics Artist', image: null, role: 'Lyrics' };
    const musicianArtist = musicians[0] ? { name: toTitleCase(musicians[0].name), image: formatImage(musicians[0].image, host), role: 'Melody' } : { name: 'Melody Artist', image: null, role: 'Melody' };
    const labelArtist = songLabelsList[0] ? { name: songLabelsList[0].name, image: songLabelsList[0].imageUrl || songLabelsList[0].image_url, role: 'Record Label' } : { name: 'Record Label', image: null, role: 'Record Label' };

    const recordLabelsData = [];
    const lyricsData = [];
    const musiciansData = [];
    const singersData = [];

    mappingRows.forEach(row => {
      const tagsList = [];
      if (row.is_recordlabel === 1) tagsList.push('Record Label');
      if (row.is_lyrics === 1) tagsList.push('Lyrics');
      if (row.is_musician === 1) tagsList.push('Musician');
      if (row.is_singer === 1) tagsList.push('Singer');
      const tagStr = tagsList.length > 0 ? tagsList.join(', ') : 'Agreement';

      const rawDocName = row.document_name || 'Document';
      const docNameClean = rawDocName.replace(/\.pdf$/i, '');
      const docFileName = `${docNameClean}.pdf`;
      const docUrl = formatDocumentUrl(row.document_url, host);

      const item = {
        mappingId: row.mapping_id,
        ownershipId: row.ownership_id,
        name: docFileName,
        rawName: docNameClean,
        size: 'PDF Document',
        badge: tagStr,
        document_url: docUrl,
        is_ownership: row.is_ownership === 1
      };

      if (row.is_recordlabel === 1) {
        recordLabelsData.push({ ...item, artist: labelArtist });
      }
      if (row.is_lyrics === 1) {
        lyricsData.push({ ...item, artist: lyricistArtist });
      }
      if (row.is_musician === 1) {
        musiciansData.push({ ...item, artist: musicianArtist });
      }
      if (row.is_singer === 1) {
        singersData.push({ ...item, artist: singerArtist });
      }
    });

    res.json({
      summary,
      recordLabels: recordLabelsData,
      lyrics: lyricsData,
      musicians: musiciansData,
      singers: singersData
    });
  } catch (error) {
    console.error('Error fetching song ownership:', error);
    res.status(500).json({ message: 'Failed to fetch song ownership' });
  }
};

// ─────────────────────────────────────────────────────────
// DELETE /songs/:id/ownership/:mappingId
// Soft deletes ownershipsong mapping record (status = 0, is_delete = 1)
// ─────────────────────────────────────────────────────────
exports.deleteSongOwnership = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const mappingId = parseInt(req.params.mappingId, 10);
    const category = (req.query.category || req.body.category || '').toLowerCase().trim();

    if (isNaN(songId) || isNaN(mappingId)) {
      return res.status(400).json({ message: 'Invalid song or mapping ID' });
    }

    // 1. Fetch existing ownershipsong mapping record
    const [rows] = await pool.query(
      `SELECT is_singer, is_lyrics, is_musician, is_recordlabel 
       FROM ownershipsong 
       WHERE id = ? AND song_id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [mappingId, songId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Ownership document mapping not found' });
    }

    const current = rows[0];
    let isSinger = current.is_singer === 1 ? 1 : 0;
    let isLyrics = current.is_lyrics === 1 ? 1 : 0;
    let isMusician = current.is_musician === 1 ? 1 : 0;
    let isRecordLabel = current.is_recordlabel === 1 ? 1 : 0;

    // 2. Set the specific sub-category column to 0 based on section deleted
    if (category === 'recordlabel' || category === 'record_label' || category === 'label') {
      isRecordLabel = 0;
    } else if (category === 'lyrics') {
      isLyrics = 0;
    } else if (category === 'musician' || category === 'melody') {
      isMusician = 0;
    } else if (category === 'singer') {
      isSinger = 0;
    } else {
      // If no specific category passed, zero out all
      isSinger = 0;
      isLyrics = 0;
      isMusician = 0;
      isRecordLabel = 0;
    }

    // 3. If ALL 4 attributes are 0, soft delete mapping (status = 0, is_delete = 1)
    //    Otherwise, update the row keeping status = 1, is_delete = 0 and updated column = 0
    if (isSinger === 0 && isLyrics === 0 && isMusician === 0 && isRecordLabel === 0) {
      await pool.query(
        `UPDATE ownershipsong 
         SET is_singer = 0, is_lyrics = 0, is_musician = 0, is_recordlabel = 0, status = 0, is_delete = 1 
         WHERE id = ? AND song_id = ?`,
        [mappingId, songId]
      );
    } else {
      await pool.query(
        `UPDATE ownershipsong 
         SET is_singer = ?, is_lyrics = ?, is_musician = ?, is_recordlabel = ?, status = 1, is_delete = 0 
         WHERE id = ? AND song_id = ?`,
        [isSinger, isLyrics, isMusician, isRecordLabel, mappingId, songId]
      );
    }

    // 4. Synchronize songs table boolean flags
    const { syncSongOwnership } = require('./ownershipController');
    if (syncSongOwnership) {
      await syncSongOwnership(pool, [songId]);
    }

    res.json({ success: true, message: 'Ownership document section removed successfully' });
  } catch (error) {
    console.error('Error deleting song ownership mapping:', error);
    res.status(500).json({ message: 'Failed to remove ownership document mapping' });
  }
};

// GET /songs/:id/albums (Song related albums & unique record labels)
exports.getSongAlbumsAndLabels = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);

    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    // 1. Fetch active, non-deleted songalbum records joined with non-deleted album & record_label details
    const [rows] = await pool.query(`
      SELECT 
        a.id as album_id,
        a.name as album_name,
        a.display_name as album_display_name,
        a.image_url as album_image,
        a.record_label_id,
        a.release_year,
        YEAR(a.created_at) as album_year,
        rl.id as label_id,
        COALESCE(rl.display_name, rl.name) as label_name,
        rl.image_url as label_image,
        (SELECT COUNT(DISTINCT sa_count.song_id) 
         FROM songalbum sa_count 
         JOIN songs s_count ON sa_count.song_id = s_count.id 
           AND (s_count.status = 1 OR s_count.status = 'Active' OR s_count.status IS NULL) 
           AND (s_count.is_delete = 0 OR s_count.is_delete IS NULL)
         WHERE sa_count.album_id = a.id 
           AND (sa_count.status = 1 OR sa_count.status IS NULL) 
           AND (sa_count.is_delete = 0 OR sa_count.is_delete IS NULL)
        ) as track_count
      FROM songalbum sa
      JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
      LEFT JOIN record_label rl ON a.record_label_id = rl.id 
        AND (rl.status = 1 OR rl.status IS NULL) 
        AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
      WHERE sa.song_id = ? 
        AND (sa.status = 1 OR sa.status IS NULL) 
        AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
      ORDER BY a.name ASC
    `, [songId]);

    const albumsMap = {};
    const recordLabelsMap = {};

    rows.forEach(r => {
      // Album object
      if (!albumsMap[r.album_id]) {
        const albumImg = formatImage(r.album_image, host);
        const labelImg = formatImage(r.label_image, host);
        const yearVal = r.release_year || (r.album_year ? String(r.album_year) : '');
        albumsMap[r.album_id] = {
          id: r.album_id,
          name: toTitleCase(r.album_name),
          image_url: albumImg,
          imageUrl: albumImg,
          coverUrl: albumImg,
          type: 'Album Type',
          record_label_id: r.record_label_id,
          recordLabelName: toTitleCase(r.label_name || '—'),
          recordLabelImage: labelImg,
          track_count: r.track_count || 0,
          songsCount: r.track_count || 0,
          tracks: `${r.track_count || 0} Tracks`,
          release_year: yearVal,
          releaseYear: yearVal,
          year: yearVal || '2024'
        };
      }

      // Unique Record Label object
      if (r.label_id && !recordLabelsMap[r.label_id]) {
        const labelImg = formatImage(r.label_image, host);
        const labelName = toTitleCase(r.label_name || '');
        recordLabelsMap[r.label_id] = {
          id: r.label_id,
          name: labelName,
          display_name: labelName,
          image_url: labelImg,
          imageUrl: labelImg
        };
      }
    });

    // 2. Fetch Version Albums (Unique albums containing active version songs of this song)
    let versionAlbums = [];
    const [vSongRows] = await pool.query(`
      SELECT id FROM songs
      WHERE originalSongId = ?
        AND (status = 1 OR status = 'Active' OR status IS NULL)
        AND (is_delete = 0 OR is_delete IS NULL)
    `, [songId]);

    if (vSongRows.length > 0) {
      const vSongIds = vSongRows.map(s => s.id);
      const [vAlbumRows] = await pool.query(`
        SELECT DISTINCT
          a.id as album_id,
          a.name as album_name,
          a.display_name as album_display_name,
          a.image_url as album_image,
          a.record_label_id,
          YEAR(a.created_at) as album_year,
          rl.id as label_id,
          COALESCE(rl.display_name, rl.name) as label_name,
          (SELECT COUNT(DISTINCT sa_count.song_id) 
           FROM songalbum sa_count 
           JOIN songs s_count ON sa_count.song_id = s_count.id 
             AND (s_count.status = 1 OR s_count.status = 'Active' OR s_count.status IS NULL) 
             AND (s_count.is_delete = 0 OR s_count.is_delete IS NULL)
           WHERE sa_count.album_id = a.id 
             AND (sa_count.status = 1 OR sa_count.status IS NULL) 
             AND (sa_count.is_delete = 0 OR sa_count.is_delete IS NULL)
          ) as track_count
        FROM songalbum sa
        JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
        LEFT JOIN record_label rl ON a.record_label_id = rl.id 
          AND (rl.status = 1 OR rl.status IS NULL) 
          AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
        WHERE sa.song_id IN (?)
          AND (sa.status = 1 OR sa.status IS NULL) 
          AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
        ORDER BY a.name ASC
      `, [vSongIds]);

      const vAlbumsMap = {};
      vAlbumRows.forEach(r => {
        if (!vAlbumsMap[r.album_id]) {
          const albumImg = formatImage(r.album_image, host);
          vAlbumsMap[r.album_id] = {
            id: r.album_id,
            name: toTitleCase(r.album_name),
            image_url: albumImg,
            imageUrl: albumImg,
            coverUrl: albumImg,
            type: 'Remastered',
            record_label_id: r.record_label_id,
            recordLabelName: toTitleCase(r.label_name || '—'),
            track_count: r.track_count || 0,
            songsCount: r.track_count || 0,
            tracks: `${r.track_count || 0} Tracks`,
            year: r.album_year ? String(r.album_year) : '2023'
          };
        }
      });

      versionAlbums = Object.values(vAlbumsMap);
    }

    const albums = Object.values(albumsMap);
    const recordLabels = Object.values(recordLabelsMap);

    res.json({
      albums,
      recordLabels,
      versionAlbums
    });
  } catch (error) {
    console.error('Error fetching song albums and labels:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// DELETE /songs/:id/albums/:albumId (Soft delete song-album relationship)
exports.removeSongAlbumRelationship = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    const albumId = parseInt(req.params.albumId, 10);

    if (isNaN(songId) || isNaN(albumId)) {
      return res.status(400).json({ message: 'Invalid song ID or album ID' });
    }

    await pool.query(`
      UPDATE songalbum
      SET status = 0, is_delete = 1
      WHERE song_id = ? AND album_id = ?
    `, [songId, albumId]);

    res.json({ success: true, message: 'Album removed from song successfully' });
  } catch (error) {
    console.error('Error removing song album relationship:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// GET /api/songs/:id/inactivate-check
// Checks active records (status = 1 and is_delete/is_deleted = 0)
// across all 8 song relationship tables.
// ─────────────────────────────────────────────────────────
exports.checkSongInactivationDependencies = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. ownershipsong
    const [ownershipRows] = await pool.query(`
      SELECT os.id, COALESCE(o.document_name, CONCAT('Ownership #', os.ownership_id)) AS name
      FROM ownershipsong os
      LEFT JOIN ownership o ON os.ownership_id = o.id
      WHERE os.song_id = ? AND (os.status = 1 OR os.status IS NULL) AND (os.is_delete = 0 OR os.is_delete IS NULL)
    `, [songId]);

    // 2. songalbum
    const [albumRows] = await pool.query(`
      SELECT sa.album_id AS id, COALESCE(a.name, a.display_name, CONCAT('Album #', sa.album_id)) AS name
      FROM songalbum sa
      JOIN album a ON sa.album_id = a.id
      WHERE sa.song_id = ? AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
    `, [songId]);

    // 3. songconflict / SongConflict
    const [conflictRows] = await pool.query(`
      SELECT sc.Id AS id, CONCAT(sc.CopyrightConflict, ' Conflict - ', sc.ConflictOwner) AS name
      FROM SongConflict sc
      WHERE sc.SongId = ? AND (sc.Status = 1 OR sc.Status IS NULL) AND (sc.IsDeleted = 0 OR sc.IsDeleted IS NULL OR sc.is_delete = 0)
    `, [songId]);

    // 4. songdistributor
    const [distributorRows] = await pool.query(`
      SELECT sd.distributor_id AS id, COALESCE(d.company_name, CONCAT('Distributor #', sd.distributor_id)) AS name
      FROM songdistributor sd
      JOIN distributors d ON sd.distributor_id = d.id
      WHERE sd.song_id = ? AND (sd.status = 1 OR sd.status IS NULL) AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL OR sd.is_delete = 0)
    `, [songId]);

    // 5. songlyrics
    const [lyricsRows] = await pool.query(`
      SELECT sl.artist_id AS id, a.name AS name
      FROM songLyrics sl
      JOIN artists a ON sl.artist_id = a.id
      WHERE sl.song_id = ? AND (sl.status = 1 OR sl.status IS NULL) AND (sl.is_delete = 0 OR sl.is_delete IS NULL)
    `, [songId]);

    // 6. songmusician
    const [musicianRows] = await pool.query(`
      SELECT sm.artist_id AS id, a.name AS name
      FROM songmusician sm
      JOIN artists a ON sm.artist_id = a.id
      WHERE sm.song_id = ? AND (sm.status = 1 OR sm.status IS NULL) AND (sm.is_delete = 0 OR sm.is_delete IS NULL)
    `, [songId]);

    // 7. songringintone
    const [ringtoneRows] = await pool.query(`
      SELECT sr.ringintone_id AS id, CONCAT(r.name, COALESCE(CONCAT(' (Code: ', sr.ringtone_code, ')'), '')) AS name
      FROM songringintone sr
      JOIN ringintone r ON sr.ringintone_id = r.id
      WHERE sr.song_id = ? AND (sr.status = 1 OR sr.status IS NULL) AND (sr.is_deleted = 0 OR sr.is_deleted IS NULL OR sr.is_delete = 0)
    `, [songId]);

    // 8. songsinger / songSinger
    const [singerRows] = await pool.query(`
      SELECT ss.artist_id AS id, a.name AS name
      FROM songSinger ss
      JOIN artists a ON ss.artist_id = a.id
      WHERE ss.song_id = ? AND (ss.status = 1 OR ss.status IS NULL) AND (ss.is_delete = 0 OR ss.is_delete IS NULL)
    `, [songId]);

    const dependencies = {
      ownerships: ownershipRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      albums: albumRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      conflicts: conflictRows.map(r => ({ id: r.id, name: r.name })),
      distributors: distributorRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      lyrics: lyricsRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      musicians: musicianRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      ringtones: ringtoneRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      singers: singerRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
    };

    const hasActiveDependencies =
      dependencies.ownerships.length > 0 ||
      dependencies.albums.length > 0 ||
      dependencies.conflicts.length > 0 ||
      dependencies.distributors.length > 0 ||
      dependencies.lyrics.length > 0 ||
      dependencies.musicians.length > 0 ||
      dependencies.ringtones.length > 0 ||
      dependencies.singers.length > 0;

    res.json({
      hasActiveDependencies,
      dependencies,
    });
  } catch (error) {
    console.error('Error checking song inactivation dependencies:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// GET /api/songs/:id/delete-check
// Checks non-deleted records (is_delete/is_deleted = 0) across all 8 song relationship tables.
// ─────────────────────────────────────────────────────────
exports.checkSongDeleteDependencies = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. ownershipsong
    const [ownershipRows] = await pool.query(`
      SELECT os.id, COALESCE(o.document_name, CONCAT('Ownership #', os.ownership_id)) AS name
      FROM ownershipsong os
      LEFT JOIN ownership o ON os.ownership_id = o.id
      WHERE os.song_id = ? AND (os.is_delete = 0 OR os.is_delete IS NULL)
    `, [songId]);

    // 2. songalbum
    const [albumRows] = await pool.query(`
      SELECT sa.album_id AS id, COALESCE(a.name, a.display_name, CONCAT('Album #', sa.album_id)) AS name
      FROM songalbum sa
      JOIN album a ON sa.album_id = a.id
      WHERE sa.song_id = ? AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
    `, [songId]);

    // 3. songconflict / SongConflict
    const [conflictRows] = await pool.query(`
      SELECT sc.Id AS id, CONCAT(sc.CopyrightConflict, ' Conflict - ', sc.ConflictOwner) AS name
      FROM SongConflict sc
      WHERE sc.SongId = ? AND (sc.IsDeleted = 0 OR sc.IsDeleted IS NULL OR sc.is_delete = 0)
    `, [songId]);

    // 4. songdistributor
    const [distributorRows] = await pool.query(`
      SELECT sd.distributor_id AS id, COALESCE(d.company_name, CONCAT('Distributor #', sd.distributor_id)) AS name
      FROM songdistributor sd
      JOIN distributors d ON sd.distributor_id = d.id
      WHERE sd.song_id = ? AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL OR sd.is_delete = 0)
    `, [songId]);

    // 5. songlyrics
    const [lyricsRows] = await pool.query(`
      SELECT sl.artist_id AS id, a.name AS name
      FROM songLyrics sl
      JOIN artists a ON sl.artist_id = a.id
      WHERE sl.song_id = ? AND (sl.is_delete = 0 OR sl.is_delete IS NULL)
    `, [songId]);

    // 6. songmusician
    const [musicianRows] = await pool.query(`
      SELECT sm.artist_id AS id, a.name AS name
      FROM songmusician sm
      JOIN artists a ON sm.artist_id = a.id
      WHERE sm.song_id = ? AND (sm.is_delete = 0 OR sm.is_delete IS NULL)
    `, [songId]);

    // 7. songringintone
    const [ringtoneRows] = await pool.query(`
      SELECT sr.ringintone_id AS id, CONCAT(r.name, COALESCE(CONCAT(' (Code: ', sr.ringtone_code, ')'), '')) AS name
      FROM songringintone sr
      JOIN ringintone r ON sr.ringintone_id = r.id
      WHERE sr.song_id = ? AND (sr.is_deleted = 0 OR sr.is_deleted IS NULL OR sr.is_delete = 0)
    `, [songId]);

    // 8. songsinger / songSinger
    const [singerRows] = await pool.query(`
      SELECT ss.artist_id AS id, a.name AS name
      FROM songSinger ss
      JOIN artists a ON ss.artist_id = a.id
      WHERE ss.song_id = ? AND (ss.is_delete = 0 OR ss.is_delete IS NULL)
    `, [songId]);

    const dependencies = {
      ownerships: ownershipRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      albums: albumRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      conflicts: conflictRows.map(r => ({ id: r.id, name: r.name })),
      distributors: distributorRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      lyrics: lyricsRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      musicians: musicianRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      ringtones: ringtoneRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
      singers: singerRows.map(r => ({ id: r.id, name: toTitleCase(r.name) })),
    };

    const hasActiveDependencies =
      dependencies.ownerships.length > 0 ||
      dependencies.albums.length > 0 ||
      dependencies.conflicts.length > 0 ||
      dependencies.distributors.length > 0 ||
      dependencies.lyrics.length > 0 ||
      dependencies.musicians.length > 0 ||
      dependencies.ringtones.length > 0 ||
      dependencies.singers.length > 0;

    res.json({
      hasActiveDependencies,
      dependencies,
    });
  } catch (error) {
    console.error('Error checking song delete dependencies:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/songs/:id/inactivate
// Inactivates song (status = 0) AND soft-deletes all active
// relationships across the 8 specified tables (status = 0, is_delete = 1).
// ─────────────────────────────────────────────────────────
exports.inactivateSong = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. Update song status to 0 (Inactive) and reset ownership flags
    await pool.query(
      'UPDATE songs SET status = 0, is_delete = 0, is_singer = 0, is_lyrics = 0, is_musician = 0, is_recordlabel = 0 WHERE id = ?',
      [songId]
    );

    // 2. Update status = 0 across the 8 relationship tables (keeping is_delete = 0)
    const safeUpdate = async (queryStr, params) => {
      try {
        await pool.query(queryStr, params);
      } catch (err) {
        console.warn(`Inactivation statement error [${queryStr}]:`, err.message);
      }
    };

    await safeUpdate('UPDATE ownershipsong SET status = 0, is_delete = 0 WHERE song_id = ? AND (is_delete = 0 OR is_delete IS NULL)', [songId]);
    await safeUpdate('UPDATE songalbum SET status = 0, is_delete = 0 WHERE song_id = ? AND (is_delete = 0 OR is_delete IS NULL)', [songId]);
    await safeUpdate('UPDATE SongConflict SET Status = 0, IsDeleted = 0, is_delete = 0 WHERE SongId = ? AND (IsDeleted = 0 OR IsDeleted IS NULL OR is_delete = 0)', [songId]);
    await safeUpdate('UPDATE songdistributor SET status = 0, is_deleted = 0, is_delete = 0 WHERE song_id = ? AND (is_deleted = 0 OR is_deleted IS NULL OR is_delete = 0)', [songId]);
    await safeUpdate('UPDATE songLyrics SET status = 0, is_delete = 0 WHERE song_id = ? AND (is_delete = 0 OR is_delete IS NULL)', [songId]);
    await safeUpdate('UPDATE songmusician SET status = 0, is_delete = 0 WHERE song_id = ? AND (is_delete = 0 OR is_delete IS NULL)', [songId]);
    await safeUpdate('UPDATE songringintone SET status = 0, is_deleted = 0, is_delete = 0 WHERE song_id = ? AND (is_deleted = 0 OR is_deleted IS NULL OR is_delete = 0)', [songId]);
    await safeUpdate('UPDATE songSinger SET status = 0, is_delete = 0 WHERE song_id = ? AND (is_delete = 0 OR is_delete IS NULL)', [songId]);

    res.json({ success: true, message: 'Song and related active relationships inactivated successfully' });
  } catch (error) {
    console.error('Error inactivating song:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/songs/:id/activate
// Activates song (status = 1, is_delete = 0) and reactivates linked records
// ONLY IF their parent master entity (artist, album, ringtone, ownership) is active (status = 1 and is_delete = 0).
// EXCEPT songdistributor which is excluded from reactivation.
// ─────────────────────────────────────────────────────────
exports.activateSong = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. Set song status = 1, is_delete = 0
    await pool.query('UPDATE songs SET status = 1, is_delete = 0 WHERE id = ?', [songId]);

    const safeUpdate = async (queryStr, params) => {
      try {
        await pool.query(queryStr, params);
      } catch (err) {
        console.warn(`Reactivation query error [${queryStr}]:`, err.message);
      }
    };

    // 2. Reactivate songSinger only if linked artist is active (status = 1, is_delete = 0)
    await safeUpdate(`
      UPDATE songSinger ss
      JOIN artists a ON ss.artist_id = a.id
      SET ss.status = 1, ss.is_delete = 0
      WHERE ss.song_id = ? AND (a.status = 1 OR a.status = 'Active' OR a.status IS NULL) AND (a.is_delete = 0 OR a.is_delete IS NULL)
    `, [songId]);

    // 3. Reactivate songLyrics only if linked artist is active (status = 1, is_delete = 0)
    await safeUpdate(`
      UPDATE songLyrics sl
      JOIN artists a ON sl.artist_id = a.id
      SET sl.status = 1, sl.is_delete = 0
      WHERE sl.song_id = ? AND (a.status = 1 OR a.status = 'Active' OR a.status IS NULL) AND (a.is_delete = 0 OR a.is_delete IS NULL)
    `, [songId]);

    // 4. Reactivate songmusician only if linked artist is active (status = 1, is_delete = 0)
    await safeUpdate(`
      UPDATE songmusician sm
      JOIN artists a ON sm.artist_id = a.id
      SET sm.status = 1, sm.is_delete = 0
      WHERE sm.song_id = ? AND (a.status = 1 OR a.status = 'Active' OR a.status IS NULL) AND (a.is_delete = 0 OR a.is_delete IS NULL)
    `, [songId]);

    // 5. Reactivate songalbum only if linked album is active (is_delete = 0)
    await safeUpdate(`
      UPDATE songalbum sa
      JOIN album a ON sa.album_id = a.id
      SET sa.status = 1, sa.is_delete = 0
      WHERE sa.song_id = ? AND (a.is_delete = 0 OR a.is_delete IS NULL)
    `, [songId]);

    // 6. Reactivate songringintone only if linked ringtone is active (status = 1, is_deleted = 0)
    await safeUpdate(`
      UPDATE songringintone sr
      JOIN ringintone r ON sr.ringintone_id = r.id
      SET sr.status = 1, sr.is_deleted = 0, sr.is_delete = 0
      WHERE sr.song_id = ? AND (r.status = 1 OR r.status IS NULL) AND (r.is_deleted = 0 OR r.is_deleted IS NULL)
    `, [songId]);

    // 7. Reactivate ownershipsong only if linked ownership is active (status = 1, is_delete = 0)
    await safeUpdate(`
      UPDATE ownershipsong os
      JOIN ownership o ON os.ownership_id = o.id
      SET os.status = 1, os.is_delete = 0
      WHERE os.song_id = ? AND (o.status = 1 OR o.status IS NULL) AND (o.is_delete = 0 OR o.is_delete IS NULL)
    `, [songId]);

    // 8. Reactivate SongConflict
    await safeUpdate(`
      UPDATE SongConflict SET Status = 1, IsDeleted = 0, is_delete = 0 WHERE SongId = ?
    `, [songId]);

    // NOTE: songdistributor is EXCLUDED from reactivation as requested.

    // 9. Recalculate ownership flags (is_singer, is_lyrics, is_musician, is_recordlabel)
    //    based on active ownershipsong rows linked to ownership docs where is_ownership = 1
    try {
      const { syncSongOwnership } = require('./ownershipController');
      if (typeof syncSongOwnership === 'function') {
        await syncSongOwnership(pool, [songId]);
      }
    } catch (syncErr) {
      console.warn('Could not recalculate ownership flags on reactivation:', syncErr.message);
    }

    res.json({ success: true, message: 'Song and associated active records reactivated successfully' });
  } catch (error) {
    console.error('Error activating song:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};

// ─────────────────────────────────────────────────────────
// DELETE /api/songs/:id
// Soft deletes a song (status = 0, is_delete = 1) and cascades
// to soft delete all linked relationship records across the 8 tables.
// ─────────────────────────────────────────────────────────
exports.deleteSong = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. Soft delete song
    await pool.query('UPDATE songs SET status = 0, is_delete = 1 WHERE id = ?', [songId]);

    const safeUpdate = async (queryStr, params) => {
      try {
        await pool.query(queryStr, params);
      } catch (err) {
        console.warn(`Soft delete error on statement [${queryStr}]:`, err.message);
      }
    };

    // 2. Cascade soft delete all linked records
    await safeUpdate('UPDATE ownershipsong SET status = 0, is_delete = 1 WHERE song_id = ?', [songId]);
    await safeUpdate('UPDATE songalbum SET status = 0, is_delete = 1 WHERE song_id = ?', [songId]);
    await safeUpdate('UPDATE SongConflict SET Status = 0, IsDeleted = 1, is_delete = 1 WHERE SongId = ?', [songId]);
    await safeUpdate('UPDATE songdistributor SET status = 0, is_deleted = 1, is_delete = 1 WHERE song_id = ?', [songId]);
    await safeUpdate('UPDATE songLyrics SET status = 0, is_delete = 1 WHERE song_id = ?', [songId]);
    await safeUpdate('UPDATE songmusician SET status = 0, is_delete = 1 WHERE song_id = ?', [songId]);
    await safeUpdate('UPDATE songringintone SET status = 0, is_deleted = 1, is_delete = 1 WHERE song_id = ?', [songId]);
    await safeUpdate('UPDATE songSinger SET status = 0, is_delete = 1 WHERE song_id = ?', [songId]);

    await createAuditLog({
      user: req.user || null,
      action: 'DELETE_SONG',
      details: `Deleted song ID ${songId}`
    });

    res.json({ success: true, message: 'Song deleted successfully' });
  } catch (error) {
    console.error('Error deleting song:', error);
    const errorMessage = (typeof error !== 'undefined' && error && (error.message || error.sqlMessage || error.toString())) ? (error.message || error.sqlMessage || error.toString()) : (typeof err !== 'undefined' && err && (err.message || err.sqlMessage || err.toString())) ? (err.message || err.sqlMessage || err.toString()) : ''
    return res.status(500).json({ message: errorMessage });
  }
};




