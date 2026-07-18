const mysql = require('mysql2/promise');
const runMigrations = require('../migrations/migrate');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};

let pool;

async function initializeDatabase() {
  let connection;
  try {
    // 1. Connect without a specific database to ensure it exists
    connection = await mysql.createConnection(dbConfig);
    const dbName = process.env.DB_NAME || 'ransilu_db';
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    console.log(`Database '${dbName}' verified/created.`);
  } catch (error) {
    console.error('Failed to verify/create database:', error.message);
    throw error;
  } finally {
    if (connection) await connection.end();
  }

  // 2. Establish connection pool with the database target
  pool = mysql.createPool({
    ...dbConfig,
    database: process.env.DB_NAME || 'ransilu_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  // 3. Run migrations and seed data
  try {
    await runMigrations(pool);
    await seedInitialData();
  } catch (error) {
    console.error('Failed to initialize database schema or seed data:', error.message);
    throw error;
  }
}

async function seedInitialData() {
  // 1. Seed Artists
  const [artistsCount] = await pool.query('SELECT COUNT(*) as count FROM artists');
  if (artistsCount[0].count === 0) {
    const mockArtists = [
      // name, artist_code, gender, music, lyrics, singer, band, other, image, status
      ['Chamath Sangeeth', 'ART000001', 'M', true, true, true, false, false, 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Nadun Nisansala', 'ART000002', 'F', true, true, true, false, false, 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Dhanushka Perera', 'ART000003', 'M', true, true, true, false, false, 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Sashika Nisansala', 'ART000004', 'F', true, true, true, false, false, 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Umaria Sinhawansa', 'ART000005', 'F', true, true, true, false, false, 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Vishwa Madushan', 'ART000006', 'M', true, true, true, false, false, 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Imesh Lakshan', 'ART000007', 'M', true, true, true, false, false, 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&q=80&w=200&h=200', true],
      ['Pasindu Ranasinghe', 'ART000008', 'M', true, true, true, false, false, 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&q=80&w=200&h=200', true]
    ];

    for (const artist of mockArtists) {
      await pool.query(
        `INSERT INTO artists (name, artist_code, gender, music, lyrics, singer, band, other, image, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        artist
      );
    }
    console.log('Seeded initial mock artists.');
  }

  // 2. Seed Songs
  const [songsCount] = await pool.query('SELECT COUNT(*) as count FROM songs');
  if (songsCount[0].count === 0) {
    const mockSongs = [
      {
        name: 'song name shinhala',
        nameSinhala: 'ගීතයේ නම සිංහලෙන්',
        status: 'Active',
        versionType: 'Original',
        ownership: 100,
        notes: 'No Cases Or Notes',
        conflict: 'No',
        trackUrl: '/uploads/audio/default_track.mp3',
        imageUrl: '/uploads/images/default_art.png',
        singers: ['Chamath Sangeeth'],
        lyricists: ['Nadun Nisansala'],
        musicians: ['Dhanushka Perera']
      },
      {
        name: 'amma shinhala melody',
        nameSinhala: 'අම්මා සිංහල මෙලඩි',
        status: 'Active',
        versionType: 'Original',
        ownership: 80,
        notes: 'No Cases Or Notes',
        conflict: 'No',
        trackUrl: '/uploads/audio/default_track.mp3',
        imageUrl: '/uploads/images/default_art.png',
        singers: ['Nadun Nisansala'],
        lyricists: ['Sashika Nisansala'],
        musicians: ['Vishwa Madushan']
      }
    ];

    for (const song of mockSongs) {
      const [songResult] = await pool.query(
        `INSERT INTO songs (name, nameSinhala, status, versionType, ownership, notes, conflict, trackUrl, imageUrl) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [song.name, song.nameSinhala, song.status === 'Active' ? 1 : 0, song.versionType, song.ownership, song.notes, song.conflict, song.trackUrl, song.imageUrl]
      );
      const songId = songResult.insertId;

      // Associate with singers
      for (const singerName of song.singers) {
        const [artist] = await pool.query('SELECT id FROM artists WHERE name = ?', [singerName]);
        if (artist.length > 0) {
          await pool.query('INSERT INTO songSinger (song_id, artist_id) VALUES (?, ?)', [songId, artist[0].id]);
        }
      }

      // Associate with lyricists
      for (const lyricistName of song.lyricists) {
        const [artist] = await pool.query('SELECT id FROM artists WHERE name = ?', [lyricistName]);
        if (artist.length > 0) {
          await pool.query('INSERT INTO songLyrics (song_id, artist_id) VALUES (?, ?)', [songId, artist[0].id]);
        }
      }

      // Associate with musicians
      for (const musicianName of song.musicians) {
        const [artist] = await pool.query('SELECT id FROM artists WHERE name = ?', [musicianName]);
        if (artist.length > 0) {
          await pool.query('INSERT INTO songmusician (song_id, artist_id) VALUES (?, ?)', [songId, artist[0].id]);
        }
      }
    }
    console.log('Seeded initial mock songs.');
  }

  // 3. Seed Distributors
  const [distributorsCount] = await pool.query('SELECT COUNT(*) as count FROM distributors');
  if (distributorsCount[0].count === 0) {
    const mockDistributors = [
      ['DST000001', 'ransilu@gmail.com', 'ransilu distribution', 30.00, 1],
      ['DST000002', 'evoke@gmail.com', 'evoke distribution', 20.00, 1],
      ['DST000003', 'dell@gmail.com', 'dell distribution', 25.00, 1]
    ];
    for (const dist of mockDistributors) {
      await pool.query(
        `INSERT INTO distributors (distributor_code, email, company_name, outgoing_percentage, status) 
         VALUES (?, ?, ?, ?, ?)`,
        dist
      );
    }
    console.log('Seeded initial mock distributors.');
  }

  // 4. Seed Ringtones
  const [ringtonesCount] = await pool.query('SELECT COUNT(*) as count FROM ringintone');
  if (ringtonesCount[0].count === 0) {
    const mockRingtones = [
      ['dialog axiata plc', 'https://images.unsplash.com/photo-1614741118887-7a4ee193a5fa?auto=format&fit=crop&q=80&w=120&h=120', 1],
      ['mobitel (pvt) ltd', 'https://images.unsplash.com/photo-1557200134-90327ee9fafa?auto=format&fit=crop&q=80&w=120&h=120', 1],
      ['hutchison telecommunications', 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=120&h=120', 1]
    ];
    for (const ring of mockRingtones) {
      await pool.query(
        `INSERT INTO ringintone (name, company_logo, status) 
         VALUES (?, ?, ?)`,
        ring
      );
    }
    console.log('Seeded initial mock ringtones.');
  }
}

function getPool() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializeDatabase first.');
  }
  return pool;
}

module.exports = {
  initializeDatabase,
  getPool,
};
