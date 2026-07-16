const { getPool } = require('../config/db');

// Get all songs
exports.getSongs = async (req, res) => {
  try {
    const pool = getPool();
    // 1. Fetch all songs
    const [songs] = await pool.query('SELECT * FROM songs ORDER BY id DESC');
    if (songs.length === 0) {
      return res.json([]);
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

    // 4. Map songs to the shape expected by the frontend
    const host = `${req.protocol}://${req.get('host')}`;
    const formattedSongs = songs.map((song) => {
      const rels = songRelations[song.id] || { singers: [], lyricists: [], musicians: [] };
      return {
        id: song.id,
        name: song.name,
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
        distributionProvider: song.distributionProvider,
        ringtoneProvider: song.ringtoneProvider,
        ringtoneId: song.ringtoneId,
        contentCode: song.contentCode,
        addedDate: song.addedDate,
        trackUrl: song.trackUrl ? (song.trackUrl.startsWith('http') ? song.trackUrl : `${host}${song.trackUrl}`) : null,
        imageUrl: song.imageUrl ? (song.imageUrl.startsWith('http') ? song.imageUrl : `${host}${song.imageUrl}`) : null,
        createdAt: song.created_at,
      };
    });

    res.json(formattedSongs);
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
        // Handle comma-separated format if sent as string
        return String(field).split(',').map(s => s.trim()).filter(Boolean);
      } catch (e) {
        return [field];
      }
    };

    // Support both direct fields and array index format from FormData
    const singers = getArrayInput(req.body.artists || req.body['artists[]'] || req.body['artists']);
    const lyricists = getArrayInput(req.body.lyrics || req.body['lyrics[]'] || req.body['lyrics']);
    const musicians = getArrayInput(req.body.music || req.body['music[]'] || req.body['music']);

    // Parse options structures
    let versionName = null;
    let originalSongId = null;
    if (req.body.versionDetails) {
      try {
        const details = typeof req.body.versionDetails === 'string' ? JSON.parse(req.body.versionDetails) : req.body.versionDetails;
        versionName = details.versionName;
        // Make sure it is numeric ID
        originalSongId = details.originalSong && !isNaN(details.originalSong) ? parseInt(details.originalSong, 10) : null;
      } catch (e) {
        console.warn('Failed to parse versionDetails:', e.message);
      }
    }

    let distributionProvider = null;
    if (req.body.distribution) {
      try {
        const dist = typeof req.body.distribution === 'string' ? JSON.parse(req.body.distribution) : req.body.distribution;
        distributionProvider = dist.provider;
      } catch (e) {
        console.warn('Failed to parse distribution:', e.message);
      }
    }

    let ringtoneProvider = null;
    let ringtoneId = null;
    let contentCode = null;
    let addedDate = null;
    if (req.body.ringtone) {
      try {
        const rt = typeof req.body.ringtone === 'string' ? JSON.parse(req.body.ringtone) : req.body.ringtone;
        ringtoneProvider = rt.provider;
        ringtoneId = rt.ringtoneId;
        contentCode = rt.contentCode;
        addedDate = rt.addedDate && rt.addedDate.trim() !== '' ? rt.addedDate : null;
      } catch (e) {
        console.warn('Failed to parse ringtone:', e.message);
      }
    }

    // Insert Song with boolean status (1/true by default)
    const [songResult] = await pool.query(
      `INSERT INTO songs (
        name, nameSinhala, status, trackUrl, imageUrl, isrcCode, other, 
        versionType, versionName, originalSongId, distributionProvider, 
        ringtoneProvider, ringtoneId, contentCode, addedDate, ownership, notes, conflict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        nameSinhala,
        1, // 1 (Active) boolean representation
        trackUrl,
        imageUrl,
        isrcCode || '',
        other || '',
        versionType || 'Original',
        versionName,
        originalSongId,
        distributionProvider,
        ringtoneProvider,
        ringtoneId,
        contentCode,
        addedDate,
        100, // Default ownership
        'No Cases Or Notes', // Default notes
        'No' // Default conflict
      ]
    );

    const songId = songResult.insertId;

    // Helper to insert relationships into separate many-to-many tables
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
            continue; // Skip if artist doesn't exist
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

    // Get list of names for returning representation from separate tables
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
      name,
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
      distributionProvider,
      ringtoneProvider,
      ringtoneId,
      contentCode,
      addedDate,
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

    // Fetch singer, lyricist, musician relations (IDs)
    const [singers] = await pool.query('SELECT artist_id FROM songSinger WHERE song_id = ?', [songId]);
    const [lyricists] = await pool.query('SELECT artist_id FROM songLyrics WHERE song_id = ?', [songId]);
    const [musicians] = await pool.query('SELECT artist_id FROM songmusician WHERE song_id = ?', [songId]);

    const host = `${req.protocol}://${req.get('host')}`;
    res.json({
      id: song.id,
      name: song.name,
      nameSinhala: song.nameSinhala,
      status: (song.status === 1 || song.status === true || song.status === '1') ? 'Active' : 'Inactive',
      isrcCode: song.isrcCode,
      other: song.other,
      versionType: song.versionType,
      versionName: song.versionName,
      originalSongId: song.originalSongId,
      distributionProvider: song.distributionProvider,
      ringtoneProvider: song.ringtoneProvider,
      ringtoneId: song.ringtoneId,
      contentCode: song.contentCode,
      addedDate: song.addedDate ? song.addedDate.toISOString().split('T')[0] : null,
      trackUrl: song.trackUrl ? (song.trackUrl.startsWith('http') ? song.trackUrl : `${host}${song.trackUrl}`) : null,
      imageUrl: song.imageUrl ? (song.imageUrl.startsWith('http') ? song.imageUrl : `${host}${song.imageUrl}`) : null,
      singers: singers.map(s => String(s.artist_id)),
      lyricists: lyricists.map(l => String(l.artist_id)),
      musicians: musicians.map(m => String(m.artist_id)),
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

    const name = (req.body.name || currentSong.name).trim();
    const nameSinhala = (req.body.nameSinhala || currentSong.nameSinhala).trim();
    const isrcCode = req.body.isrcCode !== undefined ? req.body.isrcCode.trim() : currentSong.isrcCode;
    const other = req.body.other !== undefined ? req.body.other.trim() : currentSong.other;
    const versionType = req.body.versionType !== undefined ? req.body.versionType : currentSong.versionType;

    // Parse uploaded files (if any). If not, fallback to existing paths
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

    // Parse options structures
    let versionName = currentSong.versionName;
    let originalSongId = currentSong.originalSongId;
    if (req.body.versionDetails) {
      try {
        const details = typeof req.body.versionDetails === 'string' ? JSON.parse(req.body.versionDetails) : req.body.versionDetails;
        versionName = details.versionName;
        originalSongId = details.originalSong && !isNaN(details.originalSong) ? parseInt(details.originalSong, 10) : null;
      } catch (e) {
        console.warn('Failed to parse versionDetails:', e.message);
      }
    }

    let distributionProvider = currentSong.distributionProvider;
    if (req.body.distribution) {
      try {
        const dist = typeof req.body.distribution === 'string' ? JSON.parse(req.body.distribution) : req.body.distribution;
        distributionProvider = dist ? dist.provider : null;
      } catch (e) {
        console.warn('Failed to parse distribution:', e.message);
      }
    } else if (req.body.distribution === null || req.body.distribution === 'null') {
      distributionProvider = null;
    }

    let ringtoneProvider = currentSong.ringtoneProvider;
    let ringtoneId = currentSong.ringtoneId;
    let contentCode = currentSong.contentCode;
    let addedDate = currentSong.addedDate;
    if (req.body.ringtone) {
      try {
        const rt = typeof req.body.ringtone === 'string' ? JSON.parse(req.body.ringtone) : req.body.ringtone;
        if (rt) {
          ringtoneProvider = rt.provider;
          ringtoneId = rt.ringtoneId;
          contentCode = rt.contentCode;
          addedDate = rt.addedDate && rt.addedDate.trim() !== '' ? rt.addedDate : null;
        } else {
          ringtoneProvider = null;
          ringtoneId = null;
          contentCode = null;
          addedDate = null;
        }
      } catch (e) {
        console.warn('Failed to parse ringtone:', e.message);
      }
    } else if (req.body.ringtone === null || req.body.ringtone === 'null') {
      ringtoneProvider = null;
      ringtoneId = null;
      contentCode = null;
      addedDate = null;
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
        versionType = ?, versionName = ?, originalSongId = ?, distributionProvider = ?, 
        ringtoneProvider = ?, ringtoneId = ?, contentCode = ?, addedDate = ?
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
        distributionProvider,
        ringtoneProvider,
        ringtoneId,
        contentCode,
        addedDate,
        songId
      ]
    );

    // Rebuild relationship mapping tables (delete existing first, then insert new ones)
    await pool.query('DELETE FROM songSinger WHERE song_id = ?', [songId]);
    await pool.query('DELETE FROM songLyrics WHERE song_id = ?', [songId]);
    await pool.query('DELETE FROM songmusician WHERE song_id = ?', [songId]);

    // Helper to insert relationships into separate many-to-many tables
    const insertRelations = async (artistIds, tableName) => {
      for (const idVal of artistIds) {
        let artistId = parseInt(idVal, 10);
        if (isNaN(artistId)) {
          const [artist] = await pool.query('SELECT id FROM artists WHERE name = ? OR artist_code = ?', [idVal, idVal]);
          if (artist.length > 0) {
            artistId = artist[0].id;
          } else {
            continue; // Skip if artist doesn't exist
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

    // Get list of names for returning representation
    const getArtistNamesByRole = async (tableName) => {
      const [artists] = await pool.query(`
        SELECT a.name FROM ${tableName} t 
        JOIN artists a ON t.artist_id = a.id 
        WHERE t.song_id = ?
      `, [songId]);
      return artists.map(a => a.name);
    };

    const singerNames = await getArtistNamesByRole('songSinger');
    const lyricistNames = await getArtistNamesByRole('songLyrics');
    const musicianNames = await getArtistNamesByRole('songmusician');

    const host = `${req.protocol}://${req.get('host')}`;

    res.json({
      id: songId,
      name,
      nameSinhala,
      status: (currentSong.status === 1 || currentSong.status === true || currentSong.status === '1') ? 'Active' : 'Inactive',
      artist: singerNames.length > 0 ? singerNames.join(', ') : 'None',
      artistSub: singerNames.length > 1 ? 'Due - Second Artist' : '',
      lyrics: lyricistNames.length > 0 ? lyricistNames.join(', ') : 'None',
      music: musicianNames.length > 0 ? musicianNames.join(', ') : 'None',
      ownership: currentSong.ownership || 100,
      notes: currentSong.notes || 'No Cases Or Notes',
      conflict: currentSong.conflict || 'No',
      versionType: versionType || 'Original',
      versionName,
      originalSongId,
      distributionProvider,
      ringtoneProvider,
      ringtoneId,
      contentCode,
      addedDate,
      trackUrl: trackUrl ? (trackUrl.startsWith('http') ? trackUrl : `${host}${trackUrl}`) : null,
      imageUrl: imageUrl ? (imageUrl.startsWith('http') ? imageUrl : `${host}${imageUrl}`) : null,
    });
  } catch (error) {
    console.error('Error updating song:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
