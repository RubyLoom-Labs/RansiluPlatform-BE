const { getPool } = require('../config/db');

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
    
    // Build WHERE clauses
    let whereClauses = [];
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

    if (statusFilter) {
      whereClauses.push('songs.status = ?');
      queryParams.push(statusFilter === 'Active' ? 1 : 0);
    }

    if (conflictFilter) {
      if (conflictFilter === 'Yes') {
        whereClauses.push("(songs.conflict = 'Yes' OR songs.notes LIKE '%conflict%' OR songs.notes LIKE '%review%')");
      } else {
        whereClauses.push("(songs.conflict != 'Yes' AND songs.notes NOT LIKE '%conflict%' AND songs.notes NOT LIKE '%review%')");
      }
    }

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

    // 2. Fetch all artist relations for these songs from the separate tables
    const [relations] = await pool.query(`
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
    `, [songIds, songIds, songIds]);

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

    // 3.1 Fetch active distributor relations
    const [distRelations] = await pool.query(`
      SELECT sd.song_id, sd.distributor_id, d.company_name
      FROM songdistributor sd
      JOIN distributors d ON sd.distributor_id = d.id
      WHERE sd.song_id IN (?) AND sd.status = 1
    `, [songIds]);

    const songDistributors = {};
    distRelations.forEach((rel) => {
      songDistributors[rel.song_id] = { id: rel.distributor_id, name: toTitleCase(rel.company_name) };
    });

    // 3.2 Fetch active ringtone relations
    const [ringRelations] = await pool.query(`
      SELECT sr.song_id, sr.ringintone_id, r.name, sr.ringtone_code, sr.content_code, sr.added_date
      FROM songringintone sr
      JOIN ringintone r ON sr.ringintone_id = r.id
      WHERE sr.song_id IN (?) AND sr.status = 1
    `, [songIds]);

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

    // 4. Map songs to the shape expected by the frontend
    const host = `${req.protocol}://${req.get('host')}`;
    const formattedSongs = songs.map((song) => {
      const rels = songRelations[song.id] || { singers: [], lyricists: [], musicians: [] };
      const dist = songDistributors[song.id] || null;
      const ring = songRingtones[song.id] || null;

      return {
        id: song.id,
        name: toTitleCase(song.name), // Format song name to Title Case on fetch
        nameSinhala: song.nameSinhala,
        status: (song.status === 1 || song.status === true || song.status === '1') ? 'Active' : 'Inactive',
        artist: rels.singers.length > 0 ? rels.singers.join(', ') : 'None',
        artistSub: rels.singers.length > 1 ? 'Due - Second Artist' : '',
        lyrics: rels.lyricists.length > 0 ? rels.lyricists.join(', ') : 'None',
        music: rels.musicians.length > 0 ? rels.musicians.join(', ') : 'None',
        ownership: song.ownership || 100,
        notes: song.notes || 'No Cases Or Notes',
        conflict: song.conflict || 'No',
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
    res.status(500).json({ message: 'Internal server error' });
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

    if (!trackFile || !artFile) {
      return res.status(400).json({ message: 'Both song track (MP3) and artwork (Image) are required' });
    }

    const trackUrl = `/uploads/audio/${trackFile.filename}`;
    const imageUrl = `/uploads/images/${artFile.filename}`;

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
    const lowercaseName = name.trim().toLowerCase();
    const [songResult] = await pool.query(
      `INSERT INTO songs (
        name, nameSinhala, status, trackUrl, imageUrl, isrcCode, other, 
        versionType, versionName, originalSongId, ownership, notes, conflict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 'No Cases Or Notes', 'No')`,
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

    // Insert artist relations
    const insertRelations = async (artistIds, role) => {
      let tableName = 'songSinger';
      if (role === 'lyricist') tableName = 'songLyrics';
      else if (role === 'musician') tableName = 'songmusician';

      for (const idVal of artistIds) {
        let artistId = parseInt(idVal, 10);
        if (isNaN(artistId)) {
          const [artist] = await pool.query('SELECT id FROM artists WHERE name = ? OR artist_code = ?', [idVal, idVal]);
          if (artist.length > 0) {
            artistId = artist[0].id;
          } else {
            continue;
          }
        }
        await pool.query(
          `INSERT INTO ${tableName} (song_id, artist_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE song_id = song_id`,
          [songId, artistId]
        );
      }
    };

    await insertRelations(singers, 'singer');
    await insertRelations(lyricists, 'lyricist');
    await insertRelations(musicians, 'musician');

    // 1. Save distributor mapping
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

    const getArtistNamesByRole = async (role) => {
      let tableName = 'songSinger';
      if (role === 'lyricist') tableName = 'songLyrics';
      else if (role === 'musician') tableName = 'songmusician';

      const [artists] = await pool.query(`
        SELECT a.name FROM ${tableName} t 
        JOIN artists a ON t.artist_id = a.id 
        WHERE t.song_id = ?
      `, [songId]);
      return artists.map(a => a.name);
    };

    const singerNames = await getArtistNamesByRole('singer');
    const lyricistNames = await getArtistNamesByRole('lyricist');
    const musicianNames = await getArtistNamesByRole('musician');

    const host = `${req.protocol}://${req.get('host')}`;

    // Backward compat: first ringtone entry as flat fields
    const firstRing = savedRingtones.length > 0 ? savedRingtones[0] : null;

    res.status(201).json({
      id: songId,
      name: toTitleCase(lowercaseName),
      nameSinhala,
      status: 'Active',
      artist: singerNames.length > 0 ? singerNames.join(', ') : 'None',
      artistSub: singerNames.length > 1 ? 'Due - Second Artist' : '',
      lyrics: lyricistNames.length > 0 ? lyricistNames.join(', ') : 'None',
      music: musicianNames.length > 0 ? musicianNames.join(', ') : 'None',
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
      imageUrl: `${host}${imageUrl}`,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('Error creating song:', error);
    res.status(500).json({ message: 'Internal server error' });
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

    let query = 'SELECT id FROM songs WHERE LOWER(name) = ?';
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
    res.status(500).json({ message: 'Internal server error' });
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

    const [songs] = await pool.query('SELECT * FROM songs WHERE id = ?', [songId]);
    if (songs.length === 0) {
      return res.status(404).json({ message: 'Song not found' });
    }
    const song = songs[0];

    // Fetch singer, lyricist, musician relations
    const [singers] = await pool.query(`
      SELECT ss.artist_id, a.name 
      FROM songSinger ss 
      JOIN artists a ON ss.artist_id = a.id 
      WHERE ss.song_id = ?
    `, [songId]);
    
    const [lyricists] = await pool.query(`
      SELECT sl.artist_id, a.name 
      FROM songLyrics sl 
      JOIN artists a ON sl.artist_id = a.id 
      WHERE sl.song_id = ?
    `, [songId]);
    
    const [musicians] = await pool.query(`
      SELECT sm.artist_id, a.name 
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

    const host = `${req.protocol}://${req.get('host')}`;
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
      trackUrl: song.trackUrl ? (song.trackUrl.startsWith('http') ? song.trackUrl : `${host}${song.trackUrl}`) : null,
      imageUrl: song.imageUrl ? (song.imageUrl.startsWith('http') ? song.imageUrl : `${host}${song.imageUrl}`) : null,
      singers: singers.map(s => String(s.artist_id)),
      lyricists: lyricists.map(l => String(l.artist_id)),
      musicians: musicians.map(m => String(m.artist_id)),
      artist: singers.length > 0 ? singers.map(s => s.name).join(', ') : 'None',
      lyrics: lyricists.length > 0 ? lyricists.map(l => l.name).join(', ') : 'None',
      music: musicians.length > 0 ? musicians.map(m => m.name).join(', ') : 'None',
    });
  } catch (error) {
    console.error('Error fetching song by ID:', error);
    res.status(500).json({ message: 'Internal server error' });
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

    const insertRelations = async (artistIds, tableName) => {
      for (const idVal of artistIds) {
        let artistId = parseInt(idVal, 10);
        if (isNaN(artistId)) {
          const [artist] = await pool.query('SELECT id FROM artists WHERE name = ? OR artist_code = ?', [idVal, idVal]);
          if (artist.length > 0) {
            artistId = artist[0].id;
          } else {
            continue;
          }
        }
        await pool.query(
          `INSERT INTO ${tableName} (song_id, artist_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE song_id = song_id`,
          [songId, artistId]
        );
      }
    };

    if (Array.isArray(singers)) await insertRelations(singers, 'songSinger');
    if (Array.isArray(lyricists)) await insertRelations(lyricists, 'songLyrics');
    if (Array.isArray(musicians)) await insertRelations(musicians, 'songmusician');

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
        SELECT a.id, a.name FROM ${tableName} t 
        JOIN artists a ON t.artist_id = a.id 
        WHERE t.song_id = ?
      `, [songId]);
      return artists;
    };

    const singersData = await getArtistDetailsByRole('songSinger');
    const lyricistsData = await getArtistDetailsByRole('songLyrics');
    const musiciansData = await getArtistDetailsByRole('songmusician');

    const host = `${req.protocol}://${req.get('host')}`;

    // Backward compat: first ringtone entry as flat fields
    const firstRing = savedRingtones.length > 0 ? savedRingtones[0] : null;

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
    });
  } catch (error) {
    console.error('Error updating song:', error);
    res.status(500).json({ message: 'Internal server error' });
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
    res.status(500).json({ message: 'Internal server error' });
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
       WHERE sr.song_id = ? AND sr.status = 1
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
    res.status(500).json({ message: 'Internal server error' });
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
      'UPDATE songringintone SET status = 0 WHERE song_id = ? AND ringintone_id = ?',
      [songId, ringtoneId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Song ringtone record not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing song ringtone:', error);
    res.status(500).json({ message: 'Internal server error' });
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
      `SELECT * FROM songs WHERE originalSongId = ? AND versionType = 'Version' ORDER BY id ASC`,
      [songId]
    );

    if (versionSongs.length === 0) {
      return res.json({ versions: [] });
    }

    const versionIds = versionSongs.map((s) => s.id);

    // Fetch artist relations for these version songs
    const [relations] = await pool.query(
      `SELECT ss.song_id, 'singer' AS role, a.name AS artist_name
         FROM songSinger ss JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id IN (?)
       UNION ALL
       SELECT sl.song_id, 'lyricist' AS role, a.name AS artist_name
         FROM songLyrics sl JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id IN (?)
       UNION ALL
       SELECT sm.song_id, 'musician' AS role, a.name AS artist_name
         FROM songmusician sm JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id IN (?)`,
      [versionIds, versionIds, versionIds]
    );

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
      return {
        id: s.id,
        versionName: s.versionName || toTitleCase(s.name),
        parentSong: toTitleCase(s.name),
        status: (s.status === 1 || s.status === true || s.status === '1') ? 'Active' : 'Inactive',
        artist: rels.singers.length > 0 ? rels.singers.join(', ') : 'None',
        artistSub: rels.singers.length > 1 ? 'Due - Second Artist' : '',
        lyrics: rels.lyricists.length > 0 ? rels.lyricists.join(', ') : 'None',
        music: rels.musicians.length > 0 ? rels.musicians.join(', ') : 'None',
        ownership: s.ownership || 100,
        notes: s.notes || 'No Cases Or Notes',
        conflicts: s.conflict || 'No',
      };
    });

    res.json({ versions });
  } catch (error) {
    console.error('Error fetching song versions:', error);
    res.status(500).json({ message: 'Internal server error' });
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
    res.status(500).json({ message: 'Internal server error' });
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
    res.status(500).json({ message: 'Internal server error' });
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
    res.status(500).json({ message: 'Internal server error' });
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
    res.status(500).json({ message: 'Internal server error' });
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
    res.status(500).json({ message: 'Internal server error' });
  }
};



