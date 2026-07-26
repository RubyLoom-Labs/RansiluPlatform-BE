const { getPool } = require('../config/db');
const ExcelJS = require('exceljs');

// Helper for title case
function toTitleCase(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

// GET /api/revenue (Get revenue metrics & list by type)
exports.getRevenueData = async (req, res) => {
  try {
    const pool = getPool();
    const type = req.query.type || ''; // 'songs', 'artist', 'record_labels', 'distributors'
    const fromDate = req.query.fromDate || null;
    const toDate = req.query.toDate || null;

    if (!type) {
      return res.json({
        type: null,
        summary: [],
        items: [],
        totalCount: 0
      });
    }

    if (type === 'songs') {
      const host = `${req.protocol}://${req.get('host')}`;

      // Build date filter clause once (reused in multiple queries)
      const dateWhere = fromDate && toDate
        ? `AND r.date >= '${fromDate}' AND r.date <= '${toDate}'`
        : fromDate
          ? `AND r.date >= '${fromDate}'`
          : toDate
            ? `AND r.date <= '${toDate}'`
            : '';

      // ── Run all queries in PARALLEL for maximum throughput ──────────────
      const [
        [songs],
        [revenueSumRows],
        [artistRelations],
        [labelRelations],
        [conflictRows],
        [summaryAggRows]
      ] = await Promise.all([

        // 1. Active non-deleted songs (include ownership flag columns for correct pct calculation)
        pool.query(`
          SELECT s.id, s.name, s.nameSinhala, s.isrcCode, s.notes,
                 s.is_recordlabel, s.is_lyrics, s.is_musician
          FROM songs s
          WHERE s.status = 1 AND s.is_delete = 0
          ORDER BY s.id DESC
        `),

        // 2. Revenue sums per song (Income, Earning, Outgoing)
        pool.query(`
          SELECT r.song_id,
                 SUM(r.amount) AS total_income,
                 SUM(COALESCE(r.remain_revenue, r.amount)) AS total_earning,
                 SUM(r.amount - COALESCE(r.remain_revenue, r.amount)) AS total_outgoing
          FROM revenue r
          INNER JOIN songs s ON s.id = r.song_id AND s.status = 1 AND s.is_delete = 0
          WHERE 1=1 ${dateWhere}
          GROUP BY r.song_id
        `),

        // 3. Artist/lyricist/musician relations for all active songs in one query
        pool.query(`
          SELECT ss.song_id, 'singer' AS role, a.name AS artist_name
          FROM songSinger ss
          INNER JOIN artists a ON ss.artist_id = a.id AND a.is_delete = 0
          INNER JOIN songs s ON ss.song_id = s.id AND s.status = 1 AND s.is_delete = 0
          WHERE ss.status = 1 AND ss.is_delete = 0
          UNION ALL
          SELECT sl.song_id, 'lyricist' AS role, a.name AS artist_name
          FROM songLyrics sl
          INNER JOIN artists a ON sl.artist_id = a.id AND a.is_delete = 0
          INNER JOIN songs s ON sl.song_id = s.id AND s.status = 1 AND s.is_delete = 0
          WHERE sl.status = 1 AND sl.is_delete = 0
          UNION ALL
          SELECT sm.song_id, 'musician' AS role, a.name AS artist_name
          FROM songmusician sm
          INNER JOIN artists a ON sm.artist_id = a.id AND a.is_delete = 0
          INNER JOIN songs s ON sm.song_id = s.id AND s.status = 1 AND s.is_delete = 0
          WHERE sm.status = 1 AND sm.is_delete = 0
        `),

        // 4. Record label relations via albums
        pool.query(`
          SELECT sa.song_id,
            rl.id   AS label_id,
            COALESCE(rl.display_name, rl.name) AS label_name,
            rl.image_url AS label_image
          FROM songalbum sa
          INNER JOIN songs   s  ON sa.song_id   = s.id   AND s.status = 1   AND s.is_delete = 0
          INNER JOIN album   a  ON sa.album_id  = a.id   AND a.is_delete = 0
          INNER JOIN record_label rl ON a.record_label_id = rl.id
            AND rl.status  = 1 AND rl.is_delete = 0
          WHERE sa.status = 1 AND sa.is_delete = 0
        `),

        // 5. Conflict counts
        pool.query(`
          SELECT sc.SongId AS song_id, COUNT(*) AS cCount
          FROM SongConflict sc
          INNER JOIN songs s ON sc.SongId = s.id AND s.status = 1 AND s.is_delete = 0
          WHERE sc.Status = 1 AND (sc.IsDeleted = 0 OR sc.IsDeleted IS NULL)
          GROUP BY sc.SongId
        `),

        // 6. Summary card aggregates (songs earning > 2000 / 1000-2000, income, earning, outgoing)
        pool.query(`
          SELECT
            COUNT(CASE WHEN gross_total > 2000 THEN 1 END)                AS high_earners,
            COUNT(CASE WHEN gross_total BETWEEN 1000 AND 2000 THEN 1 END) AS mid_earners,
            COALESCE(SUM(gross_total), 0)                                AS total_revenue,
            COALESCE(SUM(rem_total),   0)                                AS total_remain,
            COALESCE(SUM(gross_total) - SUM(rem_total), 0)               AS total_outgoing
          FROM (
            SELECT r.song_id,
                   SUM(r.amount)                             AS gross_total,
                   SUM(COALESCE(r.remain_revenue, r.amount)) AS rem_total
            FROM revenue r
            INNER JOIN songs s ON s.id = r.song_id AND s.status = 1 AND s.is_delete = 0
            WHERE 1=1 ${dateWhere}
            GROUP BY r.song_id
          ) agg
        `)
      ]);

      if (songs.length === 0) {
        return res.json({
          type: 'songs',
          summary: [
            { id: 1, title: 'Earn > Rs. 2,000', subtitle: 'Lifetime', value: '0', label: 'Songs' },
            { id: 2, title: 'Rs. 1,000 – Rs. 2,000', subtitle: 'Lifetime', value: '0', label: 'Songs' },
            { id: 3, subtitle: 'Lifetime', subtext: '0 songs', value: 'Rs. 0', label: 'Income' },
            { id: 4, subtitle: 'Lifetime', subtext: '0 songs', value: 'Rs. 0', label: 'Earning' },
            { id: 5, subtitle: 'Lifetime', subtext: '0 songs', value: 'Rs. 0', label: 'Out going' }
          ],
          songs: [],
          items: [],
          totalCount: 0
        });
      }

      // ── Build lookup maps (O(n) hash maps instead of nested loops) ───────
      const revenueSumMap = {};
      revenueSumRows.forEach(r => {
        revenueSumMap[r.song_id] = {
          income: parseFloat(r.total_income) || 0,
          earning: parseFloat(r.total_earning) || 0,
          outgoing: parseFloat(r.total_outgoing) || 0
        };
      });

      const songRelations = {};
      artistRelations.forEach(rel => {
        if (!songRelations[rel.song_id]) {
          songRelations[rel.song_id] = { singers: [], lyricists: [], musicians: [] };
        }
        if (rel.role === 'singer')   songRelations[rel.song_id].singers.push(rel.artist_name);
        else if (rel.role === 'lyricist') songRelations[rel.song_id].lyricists.push(rel.artist_name);
        else if (rel.role === 'musician') songRelations[rel.song_id].musicians.push(rel.artist_name);
      });

      const songLabels = {};
      labelRelations.forEach(rel => {
        if (!songLabels[rel.song_id]) songLabels[rel.song_id] = [];
        if (rel.label_name && !songLabels[rel.song_id].some(l => String(l.id) === String(rel.label_id))) {
          const img = rel.label_image;
          const formattedImg = img ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`) : null;
          songLabels[rel.song_id].push({
            id: rel.label_id,
            name: toTitleCase(rel.label_name),
            imageUrl: formattedImg,
            image_url: formattedImg,
            image: formattedImg
          });
        }
      });

      const songConflictsMap = {};
      conflictRows.forEach(row => {
        songConflictsMap[row.song_id] = parseInt(row.cCount, 10) || 0;
      });

      const songNotesCasesMap = await fetchSongNotesCasesMap(songs, pool);

      // ── Format song list ─────────────────────────────────────────────────
      const formattedSongs = songs.map(song => {
        const rels      = songRelations[song.id]  || { singers: [], lyricists: [], musicians: [] };
        const labelList = songLabels[song.id]     || [];
        const cCount    = songConflictsMap[song.id] || 0;
        const revStats  = revenueSumMap[song.id] || { income: 0, earning: 0, outgoing: 0 };

        // Ownership: calculated from flags exactly like songController.js
        const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1') ? 50 : 0;
        const isLyr = (song.is_lyrics      === 1 || song.is_lyrics      === true || song.is_lyrics      === '1') ? 25 : 0;
        const isMus = (song.is_musician    === 1 || song.is_musician    === true || song.is_musician    === '1') ? 25 : 0;
        const ownershipRaw = isRec + isLyr + isMus;

        const fmtDollar = (val) => val > 0 ? `$${val.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00';

        return {
          id:            song.id,
          name:          toTitleCase(song.name),
          nameSinhala:   song.nameSinhala || song.name,
          isrcCode:      song.isrcCode || '—',
          income:        fmtDollar(revStats.income),
          earning:       fmtDollar(revStats.earning),
          outgoing:      fmtDollar(revStats.outgoing),
          totalRevenue:  fmtDollar(revStats.income),
          revenueAmount: revStats.income,
          artist:        rels.singers.length    > 0 ? rels.singers.join(', ')    : '—',
          artistSub:     rels.singers.length    > 1 ? rels.singers.slice(1).join(', ') : '',
          ownership:     ownershipRaw,   // raw number — FE renders "N%"
        };
      });

      const totalCount   = formattedSongs.length;
      const aggRow        = summaryAggRows[0] || {};
      const highEarners   = parseInt(aggRow.high_earners,   10) || 0;
      const midEarners    = parseInt(aggRow.mid_earners,    10) || 0;
      const totalRevenue  = parseFloat(aggRow.total_revenue)    || 0;
      const totalRemain   = parseFloat(aggRow.total_remain)     || 0;
      const totalOutgoing = parseFloat(aggRow.total_outgoing)   || 0;

      const fmtUSD = (val) => `$${val.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      const summaryCards = [
        { id: 1, title: 'Earn > $2,000',       subtitle: 'Lifetime', value: `${highEarners}`, label: 'Songs' },
        { id: 2, title: '$1,000 – $2,000',      subtitle: 'Lifetime', value: `${midEarners}`,  label: 'Songs' },
        { id: 3, subtitle: 'Lifetime', subtext: `${totalCount} songs`, value: fmtUSD(totalRevenue),  label: 'Income' },
        { id: 4, subtitle: 'Lifetime', subtext: `${totalCount} songs`, value: fmtUSD(totalRemain),   label: 'Earning' },
        { id: 5, subtitle: 'Lifetime', subtext: `${totalCount} songs`, value: fmtUSD(totalOutgoing), label: 'Out going' }
      ];

      return res.json({
        type: 'songs',
        summary: summaryCards,
        songs: formattedSongs,
        items: formattedSongs,
        totalCount
      });
    }

    if (type === 'artist' || type === 'singer') {
      const [artists] = await pool.query(`
        SELECT a.id, a.name, a.status,
          (
            SELECT COUNT(DISTINCT song_id) FROM (
              SELECT song_id FROM songSinger WHERE artist_id = a.id AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
              UNION
              SELECT song_id FROM songLyrics WHERE artist_id = a.id AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
              UNION
              SELECT song_id FROM songmusician WHERE artist_id = a.id AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
            ) rel_songs
          ) AS total_songs,
          COALESCE(
            (
              SELECT SUM(COALESCE(r.remain_revenue, r.amount)) 
              FROM revenue r
              WHERE r.song_id IN (
                SELECT song_id FROM songSinger WHERE artist_id = a.id AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
                UNION
                SELECT song_id FROM songLyrics WHERE artist_id = a.id AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
                UNION
                SELECT song_id FROM songmusician WHERE artist_id = a.id AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
              )
            ), 0
          ) AS total_revenue
        FROM artists a
        WHERE (a.is_delete = 0 OR a.is_delete IS NULL)
        ORDER BY total_revenue DESC, a.id ASC
      `);

      let overallRevenue = 0;
      const formatted = artists.map(art => {
        const rev = parseFloat(art.total_revenue) || 0;
        overallRevenue += rev;
        return {
          ...art,
          name: toTitleCase(art.name),
          totalRevenue: rev > 0 ? `$${rev.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        };
      });

      const summaryCards = [
        { id: 1, title: 'Total Artists', subtitle: 'Platform', value: `${artists.length}`, label: 'Artists' },
        { id: 2, subtitle: 'Lifetime', subtext: `${artists.length} artists`, value: `$${overallRevenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}`, label: 'Earning' }
      ];

      return res.json({
        type: 'artist',
        summary: summaryCards,
        items: formatted,
        totalCount: formatted.length
      });
    }

    if (type === 'record_labels' || type === 'record_label') {
      const [labels] = await pool.query(`
        SELECT rl.id, rl.name, rl.display_name, rl.image_url, rl.status, rl.country_state,
          (
            SELECT COUNT(DISTINCT sa.song_id)
            FROM songalbum sa
            JOIN album alb ON sa.album_id = alb.id AND alb.record_label_id = rl.id AND (alb.is_delete = 0 OR alb.is_delete IS NULL)
            WHERE (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
          ) AS total_songs,
          COALESCE(
            (
              SELECT SUM(COALESCE(r.remain_revenue, r.amount))
              FROM revenue r
              JOIN songalbum sa ON r.song_id = sa.song_id AND (sa.status = 1 OR sa.status IS NULL) AND (sa.is_delete = 0 OR sa.is_delete IS NULL)
              JOIN album alb ON sa.album_id = alb.id AND alb.record_label_id = rl.id AND (alb.is_delete = 0 OR alb.is_delete IS NULL)
            ), 0
          ) AS total_revenue
        FROM record_label rl
        WHERE (rl.is_delete = 0 OR rl.is_delete IS NULL)
        ORDER BY total_revenue DESC, rl.id ASC
      `);

      let overallRevenue = 0;
      const formatted = labels.map(l => {
        const rev = parseFloat(l.total_revenue) || 0;
        overallRevenue += rev;
        return {
          ...l,
          name: toTitleCase(l.display_name || l.name),
          totalRevenue: rev > 0 ? `$${rev.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        };
      });

      const summaryCards = [
        { id: 1, title: 'Total Labels', subtitle: 'Platform', value: `${labels.length}`, label: 'Record Labels' },
        { id: 2, subtitle: 'Lifetime', subtext: `${labels.length} labels`, value: `$${overallRevenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}`, label: 'Earning' }
      ];

      return res.json({
        type: 'record_labels',
        summary: summaryCards,
        items: formatted,
        totalCount: formatted.length
      });
    }

    if (type === 'distributor' || type === 'distributors') {
      const [distributors] = await pool.query(`
        SELECT d.id, d.company_name, d.status, d.contact_number, d.email_address,
          (
            SELECT COUNT(DISTINCT sd.song_id)
            FROM songdistributor sd
            WHERE sd.distributor_id = d.id AND (sd.status = 1 OR sd.status IS NULL) AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL OR sd.is_delete = 0)
          ) AS total_songs,
          COALESCE(
            (
              SELECT SUM(COALESCE(r.remain_revenue, r.amount))
              FROM revenue r
              JOIN songdistributor sd ON r.song_id = sd.song_id AND (sd.status = 1 OR sd.status IS NULL) AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL OR sd.is_delete = 0)
              WHERE sd.distributor_id = d.id
            ), 0
          ) AS total_revenue
        FROM distributors d
        WHERE (d.is_deleted = 0 OR d.is_deleted IS NULL OR d.is_delete = 0)
        ORDER BY total_revenue DESC, d.id ASC
      `);

      let overallRevenue = 0;
      const formatted = distributors.map(dist => {
        const rev = parseFloat(dist.total_revenue) || 0;
        overallRevenue += rev;
        return {
          ...dist,
          name: toTitleCase(dist.company_name),
          totalRevenue: rev > 0 ? `$${rev.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        };
      });

      const summaryCards = [
        { id: 1, title: 'Total Distributors', subtitle: 'Platform', value: `${distributors.length}`, label: 'Distributors' },
        { id: 2, subtitle: 'Lifetime', subtext: `${distributors.length} distributors`, value: `$${overallRevenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}`, label: 'Earning' }
      ];

      return res.json({
        type: 'distributor',
        summary: summaryCards,
        items: formatted,
        totalCount: formatted.length
      });
    }

    return res.json({
      type,
      summary: [],
      items: [],
      totalCount: 0
    });
  } catch (error) {
    console.error('Error fetching revenue data:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /api/revenue/template-export
// Generates an Excel template (.xlsx) with all active & non-deleted songs (status=1, is_delete=0)
// Columns: Song ID, ISRC Code, Song Name (Sinhala Name), Date (empty), Amount (empty)
exports.exportRevenueTemplate = async (req, res) => {
  try {
    const pool = getPool();
    
    // Fetch active non-deleted songs
    const [songs] = await pool.query(`
      SELECT id, name, nameSinhala, isrcCode
      FROM songs
      WHERE (status = 1 OR status = 'Active' OR status IS NULL)
        AND (is_delete = 0 OR is_delete IS NULL)
      ORDER BY id ASC
    `);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Revenue Template');

    // Define columns exact matching user specification:
    // 1st: Song ID, 2nd: ISRC Code, 3rd: Song Name (Sinhala), 4th: Date, 5th: Amount
    worksheet.columns = [
      { header: 'Song ID', key: 'songId', width: 15 },
      { header: 'ISRC Code', key: 'isrcCode', width: 25 },
      { header: 'Song Name', key: 'songName', width: 35 },
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Amount', key: 'amount', width: 18 }
    ];

    // Style header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '0B66E3' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add rows from DB
    songs.forEach((s) => {
      worksheet.addRow({
        songId: s.id,
        isrcCode: s.isrcCode || '',
        songName: s.nameSinhala || s.name || '',
        date: '',
        amount: ''
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=revenue_template.xlsx'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error generating revenue template:', error);
    res.status(500).json({ message: 'Failed to generate revenue template' });
  }
};

// POST /api/revenue/import
// Parses uploaded filled Excel file (.xlsx or .csv) and inserts rows into `revenue` table
exports.importRevenueData = async (req, res) => {
  try {
    const pool = getPool();

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const workbook = new ExcelJS.Workbook();
    if (req.file.originalname && req.file.originalname.endsWith('.csv')) {
      await workbook.csv.readFile(req.file.path);
    } else {
      await workbook.xlsx.readFile(req.file.path);
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ message: 'Invalid or empty Excel file' });
    }

    const rowsToInsert = [];

    // Helper to extract clean string value from cell
    const extractVal = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object' && v.result !== undefined) return String(v.result);
      if (typeof v === 'object' && v.text !== undefined) return String(v.text);
      return String(v).trim();
    };

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header row

      const songIdVal = row.getCell(1).value;
      const isrcCodeVal = row.getCell(2).value;
      const songNameVal = row.getCell(3).value;
      const dateVal = row.getCell(4).value;
      const amountVal = row.getCell(5).value;

      const songId = parseInt(extractVal(songIdVal), 10);
      const isrcCode = extractVal(isrcCodeVal);
      const songName = extractVal(songNameVal);
      const date = extractVal(dateVal);
      const amountParsed = parseFloat(extractVal(amountVal));
      const amount = isNaN(amountParsed) ? 0 : amountParsed;

      if (!isNaN(songId) && songId > 0) {
        rowsToInsert.push({ songId, isrcCode, songName, date, amount });
      }
    });

    if (rowsToInsert.length === 0) {
      return res.status(400).json({ message: 'No valid revenue data rows found in the uploaded file' });
    }

    // Fetch ownership flags for all unique song IDs in one query
    const uniqueSongIds = [...new Set(rowsToInsert.map(r => r.songId))];
    const [songFlagsRows] = await pool.query(
      `SELECT id, is_recordlabel, is_lyrics, is_musician FROM songs WHERE id IN (?)`,
      [uniqueSongIds]
    );
    const songFlagsMap = {};
    songFlagsRows.forEach(s => {
      const isRec = (s.is_recordlabel === 1 || s.is_recordlabel === true || s.is_recordlabel === '1') ? 50 : 0;
      const isLyr = (s.is_lyrics     === 1 || s.is_lyrics     === true || s.is_lyrics     === '1') ? 25 : 0;
      const isMus = (s.is_musician   === 1 || s.is_musician   === true || s.is_musician   === '1') ? 25 : 0;
      songFlagsMap[s.id] = (isRec + isLyr + isMus) / 100; // ownership fraction (0.00 – 1.00)
    });

    // Insert into database table `revenue` with calculated remain_revenue
    for (const row of rowsToInsert) {
      const ownershipFraction = songFlagsMap[row.songId] !== undefined ? songFlagsMap[row.songId] : 1;
      const remainRevenue = parseFloat((row.amount * ownershipFraction).toFixed(2));
      await pool.query(
        'INSERT INTO revenue (song_id, isrc_code, song_name, date, amount, remain_revenue) VALUES (?, ?, ?, ?, ?, ?)',
        [row.songId, row.isrcCode, row.songName, row.date, row.amount, remainRevenue]
      );
    }

    res.json({
      success: true,
      count: rowsToInsert.length,
      message: `${rowsToInsert.length} revenue records imported successfully!`
    });
  } catch (error) {
    console.error('Error importing revenue file:', error);
    res.status(500).json({ message: 'Failed to process and import revenue file' });
  }
};

// GET /api/revenue/export?type=songs|artist|record_labels|distributor&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
exports.exportRevenueData = async (req, res) => {
  try {
    const pool = getPool();
    const type = req.query.type || 'songs';
    const fromDate = req.query.fromDate || null;
    const toDate = req.query.toDate || null;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`${toTitleCase(type)} Revenue Report`);

    if (type === 'songs') {
      // 1. Fetch active songs
      const [songs] = await pool.query(`
        SELECT s.id, s.name, s.nameSinhala, s.isrcCode, s.status, s.ownership, s.notes, s.conflict
        FROM songs s
        WHERE (s.status = 1 OR s.status = 'Active' OR s.status IS NULL) AND (s.is_delete = 0 OR s.is_delete IS NULL)
        ORDER BY s.id ASC
      `);

      // 2. Fetch revenue rows with Income, Earning, and Outgoing breakdown
      let revQuery = `
        SELECT song_id, isrc_code, song_name, date,
               amount,
               COALESCE(remain_revenue, amount) AS remain_revenue,
               (amount - COALESCE(remain_revenue, amount)) AS outgoing_revenue,
               DATE_FORMAT(date, '%Y-%m-%d') as dateStr
        FROM revenue
        WHERE 1=1
      `;
      const revParams = [];
      if (fromDate) {
        revQuery += ` AND date >= ?`;
        revParams.push(fromDate);
      }
      if (toDate) {
        revQuery += ` AND date <= ?`;
        revParams.push(toDate);
      }
      revQuery += ` ORDER BY date ASC`;

      const [revenueRows] = await pool.query(revQuery, revParams);

      // 3. Collect distinct dates chronologically & group revenue per song per date
      const distinctDatesSet = new Set();
      const songDateMap = {};

      // Helper: normalize any date value to 'YYYY-MM-DD' string, returning null for non-dates
      const normalizeDateStr = (val) => {
        if (!val) return null;
        const str = String(val).trim();
        const parsed = new Date(str);
        if (isNaN(parsed.getTime())) return null;

        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      };

      revenueRows.forEach(r => {
        const sId = r.song_id;
        const dStr = normalizeDateStr(r.date || r.dateStr);
        if (!dStr) return; // Skip invalid date records

        const inc = parseFloat(r.amount) || 0;
        const earn = parseFloat(r.remain_revenue) || 0;
        const out = parseFloat(r.outgoing_revenue) || 0;

        distinctDatesSet.add(dStr);

        if (!songDateMap[sId]) {
          songDateMap[sId] = {
            totalIncome: 0,
            totalEarning: 0,
            totalOutgoing: 0,
            dates: {}
          };
        }

        songDateMap[sId].totalIncome += inc;
        songDateMap[sId].totalEarning += earn;
        songDateMap[sId].totalOutgoing += out;

        if (!songDateMap[sId].dates[dStr]) {
          songDateMap[sId].dates[dStr] = { income: 0, earning: 0, outgoing: 0 };
        }
        songDateMap[sId].dates[dStr].income += inc;
        songDateMap[sId].dates[dStr].earning += earn;
        songDateMap[sId].dates[dStr].outgoing += out;
      });

      const sortedDistinctDates = Array.from(distinctDatesSet).sort();

      // 4. Multi-level headers with separator columns and distinct colors
      const datePalette = ['047857', '6D28D9', 'C2410C', '0284C7', 'B91C1C', '4338CA'];

      // Row 1 Values:
      const headerRow1Vals = ['Song Details', '', '', '', '', 'Total Revenue', '', ''];
      sortedDistinctDates.forEach(dStr => {
        headerRow1Vals.push('', dStr, '', '');
      });

      // Row 2 Values:
      const headerRow2Vals = ['Song ID', 'ISRC Code', 'Song Name', 'Sinhala Name', '', 'Income', 'Earning', 'Out Going'];
      sortedDistinctDates.forEach(() => {
        headerRow2Vals.push('', 'Income', 'Earning', 'Out Going');
      });

      const row1 = worksheet.addRow(headerRow1Vals);
      const row2 = worksheet.addRow(headerRow2Vals);

      // Merge header cells:
      worksheet.mergeCells(1, 1, 1, 4); // Song Details (Cols 1-4)
      worksheet.mergeCells(1, 6, 1, 8); // Total Revenue (Cols 6-8)

      let colPtr = 9;
      sortedDistinctDates.forEach(() => {
        worksheet.mergeCells(1, colPtr + 1, 1, colPtr + 3); // Date Header (3 cols)
        colPtr += 4;
      });

      // Style Song Details Header (Cols 1-4)
      for (let c = 1; c <= 4; c++) {
        [row1, row2].forEach(r => {
          const cell = r.getCell(c);
          cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
      }

      // Style Separator Col 5
      [row1, row2].forEach(r => {
        const cell = r.getCell(5);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'CBD5E1' } };
      });
      worksheet.getColumn(5).width = 3;

      // Style Total Revenue Header (Cols 6-8)
      for (let c = 6; c <= 8; c++) {
        [row1, row2].forEach(r => {
          const cell = r.getCell(c);
          cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0B66E3' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
      }

      // Style Dynamic Date Headers
      colPtr = 9;
      sortedDistinctDates.forEach((dStr, idx) => {
        const colorHex = datePalette[idx % datePalette.length];

        // Separator column
        const sepCol = colPtr;
        worksheet.getColumn(sepCol).width = 3;
        [row1, row2].forEach(r => {
          r.getCell(sepCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'CBD5E1' } };
        });

        // 3 Date Sub-columns
        for (let c = colPtr + 1; c <= colPtr + 3; c++) {
          [row1, row2].forEach(r => {
            const cell = r.getCell(c);
            cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorHex } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
          });
        }

        colPtr += 4;
      });

      // Set base column widths
      worksheet.getColumn(1).width = 12;
      worksheet.getColumn(2).width = 20;
      worksheet.getColumn(3).width = 28;
      worksheet.getColumn(4).width = 28;
      worksheet.getColumn(6).width = 15;
      worksheet.getColumn(7).width = 15;
      worksheet.getColumn(8).width = 15;

      colPtr = 9;
      sortedDistinctDates.forEach(() => {
        worksheet.getColumn(colPtr + 1).width = 15;
        worksheet.getColumn(colPtr + 2).width = 15;
        worksheet.getColumn(colPtr + 3).width = 15;
        colPtr += 4;
      });

      // 5. Add Data Rows for each song
      songs.forEach(s => {
        const revData = songDateMap[s.id] || { totalIncome: 0, totalEarning: 0, totalOutgoing: 0, dates: {} };
        const fmtDollar = (val) => val > 0 ? `$${val.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00';

        const rowValues = [
          s.id,
          s.isrcCode || '—',
          toTitleCase(s.name),
          s.nameSinhala || s.name,
          '', // Blank separator col 5
          fmtDollar(revData.totalIncome),
          fmtDollar(revData.totalEarning),
          fmtDollar(revData.totalOutgoing)
        ];

        sortedDistinctDates.forEach(dStr => {
          rowValues.push(''); // Blank separator col
          const dayData = revData.dates[dStr];
          if (dayData) {
            rowValues.push(fmtDollar(dayData.income), fmtDollar(dayData.earning), fmtDollar(dayData.outgoing));
          } else {
            rowValues.push('$0.00', '$0.00', '$0.00');
          }
        });

        const addedRow = worksheet.addRow(rowValues);

        // Fill background of blank separator cells in data rows
        addedRow.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F1F5F9' } };
        let sepPtr = 9;
        sortedDistinctDates.forEach(() => {
          addedRow.getCell(sepPtr).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F1F5F9' } };
          sepPtr += 4;
        });
      });
    } else if (type === 'artist' || type === 'singer') {
      const [artists] = await pool.query(`
        SELECT a.id, a.name, a.status,
          COALESCE((
            SELECT SUM(COALESCE(r.remain_revenue, r.amount)) FROM revenue r
            WHERE r.song_id IN (
              SELECT song_id FROM songSinger WHERE artist_id = a.id
              UNION SELECT song_id FROM songLyrics WHERE artist_id = a.id
              UNION SELECT song_id FROM songmusician WHERE artist_id = a.id
            )
          ), 0) AS total_revenue
        FROM artists a WHERE (a.is_delete = 0 OR a.is_delete IS NULL) ORDER BY total_revenue DESC, a.id ASC
      `);

      worksheet.columns = [
        { header: 'Artist ID', key: 'id', width: 12 },
        { header: 'Artist Name', key: 'name', width: 30 },
        { header: 'Total Revenue', key: 'totalRevenue', width: 20 }
      ];

      artists.forEach(a => {
        const rev = parseFloat(a.total_revenue) || 0;
        worksheet.addRow({
          id: a.id,
          name: toTitleCase(a.name),
          totalRevenue: rev > 0 ? `$${rev.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        });
      });
    } else if (type === 'record_labels' || type === 'record_label') {
      const [labels] = await pool.query(`
        SELECT rl.id, rl.name, rl.display_name,
          COALESCE((
            SELECT SUM(COALESCE(r.remain_revenue, r.amount)) FROM revenue r
            JOIN songalbum sa ON r.song_id = sa.song_id
            JOIN album alb ON sa.album_id = alb.id AND alb.record_label_id = rl.id
          ), 0) AS total_revenue
        FROM record_label rl WHERE (rl.is_delete = 0 OR rl.is_delete IS NULL) ORDER BY total_revenue DESC, rl.id ASC
      `);

      worksheet.columns = [
        { header: 'Label ID', key: 'id', width: 12 },
        { header: 'Label Name', key: 'name', width: 30 },
        { header: 'Total Revenue', key: 'totalRevenue', width: 20 }
      ];

      labels.forEach(l => {
        const rev = parseFloat(l.total_revenue) || 0;
        worksheet.addRow({
          id: l.id,
          name: toTitleCase(l.display_name || l.name),
          totalRevenue: rev > 0 ? `$${rev.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        });
      });
    } else if (type === 'distributor' || type === 'distributors') {
      const [distributors] = await pool.query(`
        SELECT d.id, d.company_name,
          COALESCE((
            SELECT SUM(COALESCE(r.remain_revenue, r.amount)) FROM revenue r
            JOIN songdistributor sd ON r.song_id = sd.song_id WHERE sd.distributor_id = d.id
          ), 0) AS total_revenue
        FROM distributors d WHERE (d.is_deleted = 0 OR d.is_deleted IS NULL OR d.is_delete = 0) ORDER BY total_revenue DESC, d.id ASC
      `);

      worksheet.columns = [
        { header: 'Distributor ID', key: 'id', width: 15 },
        { header: 'Company Name', key: 'name', width: 35 },
        { header: 'Total Revenue', key: 'totalRevenue', width: 20 }
      ];

      distributors.forEach(d => {
        const rev = parseFloat(d.total_revenue) || 0;
        worksheet.addRow({
          id: d.id,
          name: toTitleCase(d.company_name),
          totalRevenue: rev > 0 ? `$${rev.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        });
      });
    }

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0B66E3' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=revenue_${type}_report.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting revenue data:', error);
    res.status(500).json({ message: 'Failed to export revenue data' });
  }
};

// GET /api/revenue/song/:id
exports.getSongRevenueDetails = async (req, res) => {
  try {
    const pool = getPool();
    const songId = parseInt(req.params.id, 10);
    if (isNaN(songId)) {
      return res.status(400).json({ message: 'Invalid song ID' });
    }

    // 1. Fetch song basic info & flags
    const [songRows] = await pool.query(
      `SELECT s.id, s.name, s.nameSinhala, s.isrcCode, s.status, s.notes, s.conflict,
              s.is_recordlabel, s.is_lyrics, s.is_musician, s.is_singer, s.updated_at
       FROM songs s
       WHERE s.id = ? AND (s.is_delete = 0 OR s.is_delete IS NULL)`,
      [songId]
    );

    if (songRows.length === 0) {
      return res.status(404).json({ message: 'Song not found' });
    }
    const song = songRows[0];

    // 2. Fetch artist relations (singers, lyricists, musicians)
    const [artRows] = await pool.query(
      `SELECT ss.song_id, 'singer' AS role, a.name AS artist_name
       FROM songSinger ss INNER JOIN artists a ON ss.artist_id = a.id WHERE ss.song_id = ? AND (ss.is_delete = 0 OR ss.is_delete IS NULL)
       UNION ALL
       SELECT sl.song_id, 'lyricist' AS role, a.name AS artist_name
       FROM songLyrics sl INNER JOIN artists a ON sl.artist_id = a.id WHERE sl.song_id = ? AND (sl.is_delete = 0 OR sl.is_delete IS NULL)
       UNION ALL
       SELECT sm.song_id, 'musician' AS role, a.name AS artist_name
       FROM songmusician sm INNER JOIN artists a ON sm.artist_id = a.id WHERE sm.song_id = ? AND (sm.is_delete = 0 OR sm.is_delete IS NULL)`,
      [songId, songId, songId]
    );

    const singers = artRows.filter(r => r.role === 'singer').map(r => r.artist_name);
    const lyricists = artRows.filter(r => r.role === 'lyricist').map(r => r.artist_name);
    const musicians = artRows.filter(r => r.role === 'musician').map(r => r.artist_name);

    // 3. Fetch record labels for song (active and non-deleted only)
    const [labelRows] = await pool.query(
      `SELECT DISTINCT rl.id, COALESCE(rl.display_name, rl.name) AS label_name
       FROM songalbum sa
       INNER JOIN album a ON sa.album_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
       INNER JOIN record_label rl ON a.record_label_id = rl.id 
         AND (rl.status = 1 OR rl.status = '1' OR rl.status IS NULL) 
         AND (rl.is_delete = 0 OR rl.is_delete IS NULL)
       WHERE sa.song_id = ? AND (sa.is_delete = 0 OR sa.is_delete IS NULL)`,
      [songId]
    );

    const uniqueLabelNames = [...new Set(labelRows.map(l => l.label_name).filter(Boolean))];
    const labelNames = uniqueLabelNames.length > 0 ? uniqueLabelNames.join(', ') : 'Ransilu';

    // 4. Fetch revenue import history for this song (active records only)
    const [historyRows] = await pool.query(
      `SELECT id, song_id, isrc_code, date, amount, remain_revenue, created_at
       FROM revenue
       WHERE song_id = ? AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
       ORDER BY id DESC`,
      [songId]
    );

    // 5. Calculate metrics
    let grossIncome = 0;
    let totalEarning = 0;
    let totalOutgoing = 0;
    let minDate = null;
    let maxDate = null;

    historyRows.forEach(r => {
      const amt = parseFloat(r.amount) || 0;
      const rem = parseFloat(r.remain_revenue !== null && r.remain_revenue !== undefined ? r.remain_revenue : r.amount) || 0;
      const out = amt - rem;

      grossIncome += amt;
      totalEarning += rem;
      totalOutgoing += out;

      const dStr = r.date ? String(r.date).slice(0, 10) : null;
      if (dStr && dStr !== 'null' && dStr !== 'undefined') {
        if (!minDate || dStr < minDate) minDate = dStr;
        if (!maxDate || dStr > maxDate) maxDate = dStr;
      }
    });

    const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1');
    const isLyr = (song.is_lyrics === 1 || song.is_lyrics === true || song.is_lyrics === '1');
    const isMus = (song.is_musician === 1 || song.is_musician === true || song.is_musician === '1');

    const labelPct = isRec ? 50 : 0;
    const lyricsPct = isLyr ? 25 : 0;
    const musicPct = isMus ? 25 : 0;
    const ownershipPct = labelPct + lyricsPct + musicPct;
    const outgoingPct = 100 - ownershipPct;

    const labelShare = grossIncome * (labelPct / 100);
    const lyricsShare = grossIncome * (lyricsPct / 100);
    const musicShare = grossIncome * (musicPct / 100);

    const lastUpdateDate = historyRows.length > 0 && historyRows[0].created_at
      ? String(historyRows[0].created_at).slice(0, 10)
      : (song.updated_at ? String(song.updated_at).slice(0, 10) : 'N/A');

    res.json({
      song: {
        id: song.id,
        name: toTitleCase(song.name),
        nameSinhala: song.nameSinhala || song.name,
        isrcCode: song.isrcCode || '—',
        artist: singers.length > 0 ? singers.join(', ') : 'Singer',
        lyrics: lyricists.length > 0 ? lyricists.join(', ') : '—',
        music: musicians.length > 0 ? musicians.join(', ') : '—',
        labelNames,
        isRecordLabel: isRec,
        isLyrics: isLyr,
        isMusician: isMus
      },
      metrics: {
        grossIncome,
        totalEarning,
        totalOutgoing,
        ownershipPct,
        outgoingPct,
        labelPct,
        lyricsPct,
        musicPct,
        labelShare,
        lyricsShare,
        musicShare,
        minDate: minDate || 'N/A',
        maxDate: maxDate || 'N/A',
        lastUpdateDate
      },
      history: historyRows.map(h => ({
        id: h.id,
        date: h.date ? String(h.date).slice(0, 10) : (h.created_at ? String(h.created_at).slice(0, 10) : 'N/A'),
        amount: parseFloat(h.amount) || 0,
        remainRevenue: parseFloat(h.remain_revenue) || 0
      }))
    });
  } catch (err) {
    console.error('Error fetching song revenue details:', err);
    res.status(500).json({ message: 'Failed to load song revenue details' });
  }
};

// PUT /api/revenue/:id
exports.updateRevenueRecord = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const newAmountParsed = parseFloat(req.body.amount);

    if (isNaN(id) || isNaN(newAmountParsed) || newAmountParsed < 0) {
      return res.status(400).json({ message: 'Invalid record ID or amount' });
    }

    // 1. Fetch revenue record
    const [revRows] = await pool.query(
      `SELECT id, song_id, isrc_code, date, amount, remain_revenue
       FROM revenue
       WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [id]
    );

    if (revRows.length === 0) {
      return res.status(404).json({ message: 'Revenue record not found' });
    }
    const revRecord = revRows[0];

    // 2. Fetch song flags to calculate remain_revenue
    const [songRows] = await pool.query(
      `SELECT id, is_recordlabel, is_lyrics, is_musician FROM songs WHERE id = ?`,
      [revRecord.song_id]
    );

    let ownershipFraction = 1.0;
    if (songRows.length > 0) {
      const s = songRows[0];
      const isRec = (s.is_recordlabel === 1 || s.is_recordlabel === true || s.is_recordlabel === '1') ? 50 : 0;
      const isLyr = (s.is_lyrics === 1 || s.is_lyrics === true || s.is_lyrics === '1') ? 25 : 0;
      const isMus = (s.is_musician === 1 || s.is_musician === true || s.is_musician === '1') ? 25 : 0;
      ownershipFraction = (isRec + isLyr + isMus) / 100;
    }

    const newRemainRevenue = parseFloat((newAmountParsed * ownershipFraction).toFixed(2));

    // 3. Update database
    await pool.query(
      `UPDATE revenue SET amount = ?, remain_revenue = ? WHERE id = ?`,
      [newAmountParsed, newRemainRevenue, id]
    );

    res.json({
      success: true,
      message: 'Revenue record updated successfully',
      record: {
        id,
        amount: newAmountParsed,
        remainRevenue: newRemainRevenue
      }
    });
  } catch (err) {
    console.error('Error updating revenue record:', err);
    res.status(500).json({ message: 'Failed to update revenue record' });
  }
};

// DELETE /api/revenue/:id
exports.deleteRevenueRecord = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record ID' });
    }

    await pool.query(
      `UPDATE revenue SET status = 0, is_delete = 1 WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: 'Revenue record deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting revenue record:', err);
    res.status(500).json({ message: 'Failed to delete revenue record' });
  }
};
