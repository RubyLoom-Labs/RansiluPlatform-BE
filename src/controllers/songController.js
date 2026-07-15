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

    // 2. Fetch all artist relations for these songs
    const [relations] = await pool.query(`
      SELECT sa.song_id, sa.role, a.id as artist_id, a.name as artist_name 
      FROM song_artists sa 
      JOIN artists a ON sa.artist_id = a.id 
      WHERE sa.song_id IN (?)
    `, [songIds]);

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
        status: song.status,
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

    // Insert Song
    const [songResult] = await pool.query(
      `INSERT INTO songs (
        name, nameSinhala, status, trackUrl, imageUrl, isrcCode, other, 
        versionType, versionName, originalSongId, distributionProvider, 
        ringtoneProvider, ringtoneId, contentCode, addedDate, ownership, notes, conflict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        nameSinhala,
        'Active',
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

    // Helper to insert relationships
    const insertRelations = async (artistIds, role) => {
      for (const idVal of artistIds) {
        // If it's a numeric ID, use it directly. Otherwise look up artist by name/key
        let artistId = parseInt(idVal, 10);
        if (isNaN(artistId)) {
          // Look up by name or handle mock keys
          const [artist] = await pool.query('SELECT id FROM artists WHERE name = ? OR artist_code = ?', [idVal, idVal]);
          if (artist.length > 0) {
            artistId = artist[0].id;
          } else {
            continue; // Skip if artist doesn't exist
          }
        }
        await pool.query(
          'INSERT INTO song_artists (song_id, artist_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = role',
          [songId, artistId, role]
        );
      }
    };

    await insertRelations(singers, 'singer');
    await insertRelations(lyricists, 'lyricist');
    await insertRelations(musicians, 'musician');

    // Get list of names for returning representation
    const getArtistNamesByRole = async (role) => {
      const [artists] = await pool.query(`
        SELECT a.name FROM song_artists sa 
        JOIN artists a ON sa.artist_id = a.id 
        WHERE sa.song_id = ? AND sa.role = ?
      `, [songId, role]);
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
