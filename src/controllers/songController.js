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
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const offset = page ? (page - 1) * limit : 0;
    
    const search = req.query.search || '';
    const versionType = req.query.versionType || '';
    const excludeId = req.query.excludeId ? parseInt(req.query.excludeId, 10) : null;
    
    // Build WHERE clauses
    let whereClauses = [];
    let queryParams = [];
    
    if (search) {
      whereClauses.push('(name LIKE ? OR nameSinhala LIKE ?)');
      queryParams.push(`%${search}%`, `%${search}%`);
    }
    
    if (versionType) {
      whereClauses.push('versionType = ?');
      queryParams.push(versionType);
    }

    if (excludeId) {
      whereClauses.push('id != ?');
      queryParams.push(excludeId);
    }
    
    const whereClauseStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    
    // Fetch total count if paginated
    let totalCount = 0;
    if (page) {
      const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM songs ${whereClauseStr}`, queryParams);
      totalCount = countRows[0].total;
    }
    
    // Fetch records
    let dataQuery = `SELECT * FROM songs ${whereClauseStr} ORDER BY id DESC`;
    let queryParamsForData = [...queryParams];
    if (page) {
      dataQuery += ' LIMIT ? OFFSET ?';
      queryParamsForData.push(limit, offset);
    }
    
    const [songs] = await pool.query(dataQuery, queryParamsForData);
    if (songs.length === 0) {
      return res.json(page ? { songs: [], totalCount: 0 } : []);
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

    if (page) {
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
      await pool.query('UPDATE songdistributor SET status = 0 WHERE song_id = ?', [songId]);
      await pool.query(
        'INSERT INTO songdistributor (song_id, distributor_id, status) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE status = 1',
        [songId, distributorId]
      );
      const [distNameRows] = await pool.query('SELECT company_name FROM distributors WHERE id = ?', [distributorId]);
      if (distNameRows.length > 0) {
        distributionProvider = toTitleCase(distNameRows[0].company_name);
      }
    }

    // 2. Save ringtone mapping
    let ringintoneId = null;
    let ringtoneProvider = null;
    let ringtoneId = null;
    let contentCode = null;
    let addedDate = null;
    if (req.body.ringtone) {
      try {
        const rt = typeof req.body.ringtone === 'string' ? JSON.parse(req.body.ringtone) : req.body.ringtone;
        if (rt) {
          ringintoneId = rt.provider && !isNaN(rt.provider) ? parseInt(rt.provider, 10) : null;
          ringtoneId = rt.ringtoneId;
          contentCode = rt.contentCode;
          addedDate = rt.addedDate && rt.addedDate.trim() !== '' ? rt.addedDate : null;
        }
      } catch (e) {
        console.warn('Failed to parse ringtone:', e.message);
      }
    }

    if (ringintoneId) {
      await pool.query('UPDATE songringintone SET status = 0 WHERE song_id = ?', [songId]);
      const slTimestamp = getSriLankaTimestamp();
      await pool.query(
        `INSERT INTO songringintone (song_id, ringintone_id, status, ringtone_code, content_code, added_date) 
         VALUES (?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = 1, ringtone_code = ?, content_code = ?, added_date = ?`,
        [songId, ringintoneId, ringtoneId, contentCode, slTimestamp, ringtoneId, contentCode, slTimestamp]
      );
      const [ringNameRows] = await pool.query('SELECT name FROM ringintone WHERE id = ?', [ringintoneId]);
      if (ringNameRows.length > 0) {
        ringtoneProvider = toTitleCase(ringNameRows[0].name);
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

    res.status(201).json({
      id: songId,
      name: toTitleCase(lowercaseName), // Return Title Case
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
      ringtoneProvider,
      ringtoneId,
      contentCode,
      addedDate,
      ringintoneId: ringintoneId ? String(ringintoneId) : null,
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

    // Fetch active ringtone
    const [ringRows] = await pool.query(`
      SELECT sr.ringintone_id, r.name, sr.ringtone_code, sr.content_code, sr.added_date
      FROM songringintone sr
      JOIN ringintone r ON sr.ringintone_id = r.id
      WHERE sr.song_id = ? AND sr.status = 1
    `, [songId]);
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
      addedDate: activeRing && activeRing.added_date ? activeRing.added_date.toISOString().split('T')[0] : null,
      ringintoneId: activeRing ? String(activeRing.ringintone_id) : null,
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
      await pool.query('UPDATE songdistributor SET status = 0 WHERE song_id = ?', [songId]);
      await pool.query(
        'INSERT INTO songdistributor (song_id, distributor_id, status) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE status = 1',
        [songId, distributorId]
      );
      const [distNameRows] = await pool.query('SELECT company_name FROM distributors WHERE id = ?', [distributorId]);
      if (distNameRows.length > 0) {
        distributionProvider = toTitleCase(distNameRows[0].company_name);
      }
    } else if (req.body.distribution === null || req.body.distribution === 'null') {
      await pool.query('UPDATE songdistributor SET status = 0 WHERE song_id = ?', [songId]);
    }

    // 4. Save ringtone mapping
    let ringintoneId = null;
    let ringtoneProvider = null;
    let ringtoneId = null;
    let contentCode = null;
    let addedDate = null;
    if (req.body.ringtone) {
      try {
        const rt = typeof req.body.ringtone === 'string' ? JSON.parse(req.body.ringtone) : req.body.ringtone;
        if (rt) {
          ringintoneId = rt.provider && !isNaN(rt.provider) ? parseInt(rt.provider, 10) : null;
          ringtoneId = rt.ringtoneId;
          contentCode = rt.contentCode;
          addedDate = rt.addedDate && rt.addedDate.trim() !== '' ? rt.addedDate : null;
        }
      } catch (e) {
        console.warn('Failed to parse ringtone:', e.message);
      }
    }

    if (ringintoneId) {
      await pool.query('UPDATE songringintone SET status = 0 WHERE song_id = ?', [songId]);
      const slTimestamp = getSriLankaTimestamp();
      await pool.query(
        `INSERT INTO songringintone (song_id, ringintone_id, status, ringtone_code, content_code, added_date) 
         VALUES (?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = 1, ringtone_code = ?, content_code = ?, added_date = ?`,
        [songId, ringintoneId, ringtoneId, contentCode, slTimestamp, ringtoneId, contentCode, slTimestamp]
      );
      const [ringNameRows] = await pool.query('SELECT name FROM ringintone WHERE id = ?', [ringintoneId]);
      if (ringNameRows.length > 0) {
        ringtoneProvider = toTitleCase(ringNameRows[0].name);
      }
    } else if (req.body.ringtone === null || req.body.ringtone === 'null') {
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

    res.json({
      id: songId,
      name: toTitleCase(name), // Return Title Case
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
      ringtoneProvider,
      ringtoneId,
      contentCode,
      addedDate,
      ringintoneId: ringintoneId ? String(ringintoneId) : null,
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
