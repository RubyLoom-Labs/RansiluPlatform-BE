const { getPool } = require('../config/db');
const ExcelJS = require('exceljs');

// Helper for title case
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

        // 2. Revenue sums per song (with optional date range using remain_revenue)
        pool.query(`
          SELECT r.song_id, SUM(COALESCE(r.remain_revenue, r.amount)) AS total_amount
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
        revenueSumMap[r.song_id] = parseFloat(r.total_amount) || 0;
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

      // ── Format song list ─────────────────────────────────────────────────
      const formattedSongs = songs.map(song => {
        const rels      = songRelations[song.id]  || { singers: [], lyricists: [], musicians: [] };
        const labelList = songLabels[song.id]     || [];
        const cCount    = songConflictsMap[song.id] || 0;
        const sumAmt    = revenueSumMap[song.id]   || 0;

        // Ownership: calculated from flags exactly like songController.js
        const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1') ? 50 : 0;
        const isLyr = (song.is_lyrics      === 1 || song.is_lyrics      === true || song.is_lyrics      === '1') ? 25 : 0;
        const isMus = (song.is_musician    === 1 || song.is_musician    === true || song.is_musician    === '1') ? 25 : 0;
        const ownershipRaw = isRec + isLyr + isMus;

        return {
          id:            song.id,
          name:          toTitleCase(song.name),
          nameSinhala:   song.nameSinhala || song.name,
          isrcCode:      song.isrcCode || '—',
          totalRevenue:  sumAmt > 0 ? `$${sumAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00',
          revenueAmount: sumAmt,
          artist:        rels.singers.length    > 0 ? rels.singers.join(', ')    : '—',
          artistSub:     rels.singers.length    > 1 ? rels.singers.slice(1).join(', ') : '',
          lyrics:        rels.lyricists.length  > 0 ? rels.lyricists.join(', ')  : '—',
          music:         rels.musicians.length  > 0 ? rels.musicians.join(', ')  : '—',
          labels:        labelList,
          recordLabels:  labelList,
          ownership:     ownershipRaw,   // raw number — FE renders "N%"
          notes:         song.notes || '—',
          conflictCount: cCount,
          conflicts:     cCount > 0 ? 'Yes' : 'No',
          conflict:      cCount > 0 ? 'Yes' : 'No'
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

      // 2. Fetch revenue rows with optional date filtering using remain_revenue
      let revQuery = `
        SELECT song_id, isrc_code, song_name, date, COALESCE(remain_revenue, amount) as amount, DATE_FORMAT(date, '%Y-%m-%d') as dateStr
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
      const songDateMap = {}; // { [song_id]: { totalAmount: 0, dates: { [dateStr]: amountSum } } }

      // Helper: normalize any date value to 'YYYY-MM-DD' string
      const normalizeDateStr = (val) => {
        if (!val) return null;
        // DATE_FORMAT already returns a string like '2026-07-25'
        if (typeof val === 'string') return val.slice(0, 10);
        // MySQL date columns come back as JS Date objects
        if (val instanceof Date) {
          const y = val.getFullYear();
          const m = String(val.getMonth() + 1).padStart(2, '0');
          const d = String(val.getDate()).padStart(2, '0');
          return `${y}-${m}-${d}`;
        }
        return String(val).slice(0, 10);
      };

      revenueRows.forEach(r => {
        const sId = r.song_id;
        // Use dateStr (from DATE_FORMAT) first; fall back to r.date if needed
        const dStr = normalizeDateStr(r.dateStr || r.date);
        const amt = parseFloat(r.amount) || 0;

        if (dStr) {
          distinctDatesSet.add(dStr);
        }

        if (!songDateMap[sId]) {
          songDateMap[sId] = { totalAmount: 0, dates: {} };
        }
        songDateMap[sId].totalAmount += amt;

        if (dStr) {
          songDateMap[sId].dates[dStr] = (songDateMap[sId].dates[dStr] || 0) + amt;
        }
      });

      const sortedDistinctDates = Array.from(distinctDatesSet).sort();

      // 4. Define Columns exact as requested:
      // Column 1: Song ID, Column 2: ISRC Code, Column 3: Song Name, Column 4: Sinhala Name, Column 5: Total Amount,
      // Column 6+: Dynamic Date columns (each enter date wise revenue)
      const columns = [
        { header: 'Song ID', key: 'id', width: 12 },
        { header: 'ISRC Code', key: 'isrcCode', width: 22 },
        { header: 'Song Name', key: 'name', width: 30 },
        { header: 'Sinhala Name', key: 'nameSinhala', width: 30 },
        { header: 'Total Amount', key: 'totalAmount', width: 18 }
      ];

      sortedDistinctDates.forEach(dStr => {
        columns.push({
          header: dStr,
          key: `date_${dStr}`,
          width: 16
        });
      });

      worksheet.columns = columns;

      // Style header row
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0B66E3' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

      // 5. Add rows for each song
      songs.forEach(s => {
        const revData = songDateMap[s.id] || { totalAmount: 0, dates: {} };
        const rowObj = {
          id: s.id,
          isrcCode: s.isrcCode || '—',
          name: toTitleCase(s.name),
          nameSinhala: s.nameSinhala || s.name,
          totalAmount: revData.totalAmount > 0 ? `$${revData.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00'
        };

        sortedDistinctDates.forEach(dStr => {
          const dayAmt = revData.dates[dStr];
          rowObj[`date_${dStr}`] = dayAmt !== undefined ? `$${dayAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '';
        });

        worksheet.addRow(rowObj);
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
