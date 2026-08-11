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

        // 2. Revenue sums per song (Income, Distributor 30%, Earning, Outgoing)
        pool.query(`
          SELECT r.song_id,
                 SUM(r.amount) AS total_income,
                 SUM(COALESCE(r.distributor_amount, r.amount * 0.30)) AS total_distributor,
                 SUM(COALESCE(r.remain_revenue, (r.amount * 0.70))) AS total_earning,
                 SUM(r.amount - COALESCE(r.distributor_amount, r.amount * 0.30) - COALESCE(r.remain_revenue, (r.amount * 0.70))) AS total_outgoing
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
          distributor: parseFloat(r.total_distributor) || 0,
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
        const revStats  = revenueSumMap[song.id] || { income: 0, distributor: 0, earning: 0, outgoing: 0 };

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
          distributor:   fmtDollar(revStats.distributor),
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
      const host = `${req.protocol}://${req.get('host')}`;

      // 1. Fetch all non-deleted artists
      const [artists] = await pool.query(`
        SELECT a.id, a.name, a.status, a.image AS image_url
        FROM artists a
        WHERE (a.is_delete = 0 OR a.is_delete IS NULL)
        ORDER BY a.id ASC
      `);

      // 2. For every artist, get the songs where they are main (is_main=1 or is_main IS NULL)
      //    along with each song's revenue totals and ownership flags
      const [mainSongRows] = await pool.query(`
        SELECT rel.artist_id, rel.song_id, rel.role,
               s.is_recordlabel, s.is_lyrics, s.is_musician,
               COALESCE(rv.total_amount, 0) AS total_amount,
               COALESCE(rv.total_distributor, 0) AS total_distributor
        FROM (
          SELECT ss.artist_id, ss.song_id, 'singer' AS role
          FROM songSinger ss
          INNER JOIN songs s ON ss.song_id = s.id AND s.status=1 AND s.is_delete=0
          WHERE ss.status=1 AND ss.is_delete=0 AND (ss.is_main = 1 OR ss.is_main IS NULL)
          UNION
          SELECT sl.artist_id, sl.song_id, 'lyricist' AS role
          FROM songLyrics sl
          INNER JOIN songs s ON sl.song_id = s.id AND s.status=1 AND s.is_delete=0
          WHERE sl.status=1 AND sl.is_delete=0 AND (sl.is_main = 1 OR sl.is_main IS NULL)
          UNION
          SELECT sm.artist_id, sm.song_id, 'musician' AS role
          FROM songmusician sm
          INNER JOIN songs s ON sm.song_id = s.id AND s.status=1 AND s.is_delete=0
          WHERE sm.status=1 AND sm.is_delete=0 AND (sm.is_main = 1 OR sm.is_main IS NULL)
        ) rel
        INNER JOIN songs s ON rel.song_id = s.id
        LEFT JOIN (
          SELECT r.song_id,
                 SUM(r.amount) AS total_amount,
                 SUM(COALESCE(r.distributor_amount, r.amount * 0.30)) AS total_distributor
          FROM revenue r
          WHERE (r.status=1 OR r.status IS NULL) AND (r.is_delete=0 OR r.is_delete IS NULL)
          GROUP BY r.song_id
        ) rv ON rv.song_id = rel.song_id
      `);

      // 3. Build per-artist aggregation
      // For each artist → unique songs → per song: income, distributor(30%), then
      //   remaining 70% → earning = portions where is_recordlabel/is_lyrics/is_musician = 1
      //                  → outgoing = portions where those flags = 0
      const artistDataMap = {};
      mainSongRows.forEach(row => {
        const aid = row.artist_id;
        if (!artistDataMap[aid]) {
          artistDataMap[aid] = { songMap: {}, roles: new Set() };
        }
        artistDataMap[aid].roles.add(row.role);
        // Only count each song once per artist (UNION already deduplicates but we join roles)
        if (!artistDataMap[aid].songMap[row.song_id]) {
          const amount = parseFloat(row.total_amount) || 0;
          const distributor = parseFloat(row.total_distributor) || 0;
          const afterDistributor = amount - distributor; // 70% of amount

          // Ownership flags: which portions are "ours" (earning) vs "artist" (outgoing)
          const isRec = (row.is_recordlabel === 1 || row.is_recordlabel === true || row.is_recordlabel === '1');
          const isLyr = (row.is_lyrics === 1 || row.is_lyrics === true || row.is_lyrics === '1');
          const isMus = (row.is_musician === 1 || row.is_musician === true || row.is_musician === '1');

          // Each flag represents a portion: recordlabel=50%, lyrics=25%, musician=25%
          const earningPct = (isRec ? 50 : 0) + (isLyr ? 25 : 0) + (isMus ? 25 : 0);
          const outgoingPct = 100 - earningPct;

          const earning = afterDistributor * (earningPct / 100);
          const outgoing = afterDistributor * (outgoingPct / 100);

          artistDataMap[aid].songMap[row.song_id] = {
            income: amount,
            distributor,
            earning,
            outgoing
          };
        }
      });

      // 4. Format result per artist
      let overallIncome = 0;
      let overallDistributor = 0;
      let overallEarning = 0;
      let overallOutgoing = 0;

      const formatted = artists.map(art => {
        const data = artistDataMap[art.id];
        const songCount = data ? Object.keys(data.songMap).length : 0;
        let income = 0, distributor = 0, earning = 0, outgoing = 0;

        if (data) {
          Object.values(data.songMap).forEach(s => {
            income += s.income;
            distributor += s.distributor;
            earning += s.earning;
            outgoing += s.outgoing;
          });
        }

        overallIncome += income;
        overallDistributor += distributor;
        overallEarning += earning;
        overallOutgoing += outgoing;

        const img = art.image_url;
        const formattedImg = img
          ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`)
          : null;

        const types = [];
        if (data) {
          if (data.roles.has('singer')) types.push('Singer');
          if (data.roles.has('lyricist')) types.push('Lyrics');
          if (data.roles.has('musician')) types.push('Music');
        }

        const fmtUSD = (v) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

        return {
          ...art,
          name: toTitleCase(art.name),
          image_url: formattedImg,
          avatar: formattedImg,
          types,
          total_songs: songCount,
          grossIncome: income,
          totalEarning: earning,
          totalOutgoing: outgoing,
          totalDistributor: distributor,
          totalRevenue: fmtUSD(earning),
          income: fmtUSD(income),
          distributor: fmtUSD(distributor),
          earning: fmtUSD(earning),
          outgoing: fmtUSD(outgoing)
        };
      }).filter(a => a.total_songs > 0) // Only show artists with main-artist songs
        .sort((a, b) => b.grossIncome - a.grossIncome); // Sort by income desc

      const fmtUSD = (v) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      const summaryCards = [
        { id: 1, title: 'Total Artists', subtitle: 'Platform', value: `${formatted.length}`, label: 'Artists' },
        { id: 2, subtitle: 'Lifetime', subtext: `${formatted.length} artists`, value: fmtUSD(overallIncome), label: 'Income' },
        { id: 3, subtitle: 'Lifetime', subtext: `${formatted.length} artists`, value: fmtUSD(overallEarning), label: 'Earning' },
        { id: 4, subtitle: 'Lifetime', subtext: `${formatted.length} artists`, value: fmtUSD(overallOutgoing), label: 'Out going' }
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
              SELECT SUM(COALESCE(r.distributor_amount, r.amount * 0.30))
              FROM revenue r
              JOIN songdistributor sd ON r.song_id = sd.song_id AND (sd.status = 1 OR sd.status IS NULL) AND (sd.is_deleted = 0 OR sd.is_deleted IS NULL OR sd.is_delete = 0)
              WHERE sd.distributor_id = d.id AND (r.status = 1 OR r.status IS NULL) AND (r.is_delete = 0 OR r.is_delete IS NULL)
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
// Generates an Excel template (.xlsx) with active & non-deleted songs.
// When distributorId is provided, only songs linked to that distributor
// (via songdistributor where status=1 AND is_deleted=0) are exported.
// Columns: Song ID, ISRC Code, Song Name (Sinhala Name), Date (empty), Amount (empty)
exports.exportRevenueTemplate = async (req, res) => {
  try {
    const pool = getPool();
    const distributorId = req.query.distributorId ? parseInt(req.query.distributorId, 10) : null;

    let songs;
    let distributorLabel = '';

    if (distributorId && !isNaN(distributorId)) {
      // Fetch distributor info for filename/label
      const [distRows] = await pool.query(
        `SELECT company_name, email FROM distributors WHERE id = ? AND is_deleted = 0 AND status = 1`,
        [distributorId]
      );
      if (distRows.length === 0) {
        return res.status(404).json({ message: 'Distributor not found or is inactive' });
      }
      distributorLabel = distRows[0].company_name || distRows[0].email || `dist_${distributorId}`;

      // Only songs linked to this active distributor (song must also be active & non-deleted)
      [songs] = await pool.query(`
        SELECT DISTINCT s.id, s.name, s.nameSinhala, s.isrcCode
        FROM songs s
        JOIN songdistributor sd ON sd.song_id = s.id
        WHERE sd.distributor_id = ?
          AND sd.status = 1
          AND sd.is_deleted = 0
          AND s.status = 1
          AND (s.is_delete = 0 OR s.is_delete IS NULL)
        ORDER BY s.id ASC
      `, [distributorId]);
    } else {
      // All active non-deleted songs
      [songs] = await pool.query(`
        SELECT id, name, nameSinhala, isrcCode
        FROM songs
        WHERE (status = 1 OR status = 'Active' OR status IS NULL)
          AND (is_delete = 0 OR is_delete IS NULL)
        ORDER BY id ASC
      `);
    }

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
    const safeLabel = distributorLabel
      ? `_${distributorLabel.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40)}`
      : '';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=revenue_template${safeLabel}.xlsx`
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

    // Helper to normalize a date cell (Date object, Excel serial number, or string) to 'YYYY-MM-DD'.
    // This guarantees the value fits VARCHAR(50) and sorts/compares correctly as an ISO date string.
    const normalizeDateForStorage = (v) => {
      if (v === null || v === undefined || v === '') return null;
      let d;
      if (v instanceof Date) {
        d = v;
      } else if (typeof v === 'number') {
        // Excel serial date (days since 1899-12-30)
        d = new Date(Math.round((v - 25569) * 86400 * 1000));
      } else if (typeof v === 'object' && v.result !== undefined) {
        return normalizeDateForStorage(v.result);
      } else {
        d = new Date(String(v).trim());
      }
      if (isNaN(d.getTime())) return null;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
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
      // Use the date exactly as provided in the Excel file's date column, normalized to YYYY-MM-DD.
      // Falls back to today's date only when the cell is empty/unparseable.
      const date = normalizeDateForStorage(dateVal) || normalizeDateForStorage(new Date());
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

    // Insert into database table `revenue` with calculated distributor_amount (30%) and remain_revenue (from 70% remaining * ownershipFraction)
    for (const row of rowsToInsert) {
      const ownershipFraction = songFlagsMap[row.songId] !== undefined ? songFlagsMap[row.songId] : 1;
      const distributorAmount = parseFloat((row.amount * 0.30).toFixed(2));
      const amountAfterDistributor = row.amount * 0.70;
      const remainRevenue = parseFloat((amountAfterDistributor * ownershipFraction).toFixed(2));
      await pool.query(
        'INSERT INTO revenue (song_id, isrc_code, song_name, date, amount, distributor_amount, remain_revenue) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.songId, row.isrcCode, row.songName, row.date, row.amount, distributorAmount, remainRevenue]
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
      // Same logic as getRevenueData artist - fetch main artist songs with ownership breakdown
      const [mainSongRows] = await pool.query(`
        SELECT rel.artist_id, a.name AS artist_name, rel.song_id,
               s.is_recordlabel, s.is_lyrics, s.is_musician,
               COALESCE(rv.total_amount, 0) AS total_amount,
               COALESCE(rv.total_distributor, 0) AS total_distributor
        FROM (
          SELECT ss.artist_id, ss.song_id FROM songSinger ss
          INNER JOIN songs s2 ON ss.song_id = s2.id AND s2.status=1 AND s2.is_delete=0
          WHERE ss.status=1 AND ss.is_delete=0 AND (ss.is_main = 1 OR ss.is_main IS NULL)
          UNION
          SELECT sl.artist_id, sl.song_id FROM songLyrics sl
          INNER JOIN songs s2 ON sl.song_id = s2.id AND s2.status=1 AND s2.is_delete=0
          WHERE sl.status=1 AND sl.is_delete=0 AND (sl.is_main = 1 OR sl.is_main IS NULL)
          UNION
          SELECT sm.artist_id, sm.song_id FROM songmusician sm
          INNER JOIN songs s2 ON sm.song_id = s2.id AND s2.status=1 AND s2.is_delete=0
          WHERE sm.status=1 AND sm.is_delete=0 AND (sm.is_main = 1 OR sm.is_main IS NULL)
        ) rel
        INNER JOIN artists a ON rel.artist_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
        INNER JOIN songs s ON rel.song_id = s.id
        LEFT JOIN (
          SELECT r.song_id, SUM(r.amount) AS total_amount,
                 SUM(COALESCE(r.distributor_amount, r.amount * 0.30)) AS total_distributor
          FROM revenue r WHERE (r.status=1 OR r.status IS NULL) AND (r.is_delete=0 OR r.is_delete IS NULL)
          GROUP BY r.song_id
        ) rv ON rv.song_id = rel.song_id
      `);

      // Aggregate per artist
      const artistExportMap = {};
      mainSongRows.forEach(row => {
        const aid = row.artist_id;
        if (!artistExportMap[aid]) {
          artistExportMap[aid] = { id: aid, name: row.artist_name, income: 0, distributor: 0, earning: 0, outgoing: 0, songs: new Set() };
        }
        if (!artistExportMap[aid].songs.has(row.song_id)) {
          artistExportMap[aid].songs.add(row.song_id);
          const amount = parseFloat(row.total_amount) || 0;
          const dist = parseFloat(row.total_distributor) || 0;
          const afterDist = amount - dist;
          const isRec = (row.is_recordlabel === 1 || row.is_recordlabel === true || row.is_recordlabel === '1');
          const isLyr = (row.is_lyrics === 1 || row.is_lyrics === true || row.is_lyrics === '1');
          const isMus = (row.is_musician === 1 || row.is_musician === true || row.is_musician === '1');
          const earningPct = (isRec ? 50 : 0) + (isLyr ? 25 : 0) + (isMus ? 25 : 0);
          artistExportMap[aid].income += amount;
          artistExportMap[aid].distributor += dist;
          artistExportMap[aid].earning += afterDist * (earningPct / 100);
          artistExportMap[aid].outgoing += afterDist * ((100 - earningPct) / 100);
        }
      });

      const fmtD = (v) => v > 0 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00';
      const exportArtists = Object.values(artistExportMap).sort((a, b) => b.income - a.income);

      worksheet.columns = [
        { header: 'Artist ID', key: 'id', width: 12 },
        { header: 'Artist Name', key: 'name', width: 30 },
        { header: 'Income', key: 'income', width: 18 },
        { header: 'Distributor (30%)', key: 'distributor', width: 18 },
        { header: 'Earning', key: 'earning', width: 18 },
        { header: 'Out Going', key: 'outgoing', width: 18 }
      ];

      exportArtists.forEach(a => {
        worksheet.addRow({
          id: a.id,
          name: toTitleCase(a.name),
          income: fmtD(a.income),
          distributor: fmtD(a.distributor),
          earning: fmtD(a.earning),
          outgoing: fmtD(a.outgoing)
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
            SELECT SUM(COALESCE(r.distributor_amount, r.amount * 0.30)) FROM revenue r
            JOIN songdistributor sd ON r.song_id = sd.song_id WHERE sd.distributor_id = d.id AND (r.status = 1 OR r.status IS NULL) AND (r.is_delete = 0 OR r.is_delete IS NULL)
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
      `SELECT id, song_id, isrc_code, date, amount, distributor_amount, remain_revenue, created_at
       FROM revenue
       WHERE song_id = ? AND (status = 1 OR status IS NULL) AND (is_delete = 0 OR is_delete IS NULL)
       ORDER BY id DESC`,
      [songId]
    );

    // 5. Calculate metrics
    let grossIncome = 0;
    let totalDistributor = 0;
    let minDate = null;
    let maxDate = null;

    historyRows.forEach(r => {
      const amt = parseFloat(r.amount) || 0;
      const dist = parseFloat(r.distributor_amount) || (amt * 0.30);

      grossIncome += amt;
      totalDistributor += dist;

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

    // After removing 30% distributor, compute ownership-based shares on the remaining 70%
    const afterDistributor = grossIncome - totalDistributor;
    const totalEarning = afterDistributor * (ownershipPct / 100);
    const totalOutgoing = afterDistributor * (outgoingPct / 100);

    // Share amounts calculated on after-distributor amount
    const labelShare = afterDistributor * (labelPct / 100);
    const lyricsShare = afterDistributor * (lyricsPct / 100);
    const musicShare = afterDistributor * (musicPct / 100);

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
        distributorAmount: totalDistributor,
        distributorPct: 30,
        afterDistributor,
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
        distributorAmount: parseFloat(h.distributor_amount) || 0,
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

    const newDistributorAmount = parseFloat((newAmountParsed * 0.30).toFixed(2));
    const amountAfterDistributor = newAmountParsed * 0.70;
    const newRemainRevenue = parseFloat((amountAfterDistributor * ownershipFraction).toFixed(2));

    // 3. Update database
    await pool.query(
      `UPDATE revenue SET amount = ?, distributor_amount = ?, remain_revenue = ? WHERE id = ?`,
      [newAmountParsed, newDistributorAmount, newRemainRevenue, id]
    );

    res.json({
      success: true,
      message: 'Revenue record updated successfully',
      record: {
        id,
        amount: newAmountParsed,
        distributorAmount: newDistributorAmount,
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

// GET /api/revenue/artist/:id
exports.getArtistRevenueDetails = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);
    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    const host = `${req.protocol}://${req.get('host')}`;

    // 1. Artist info
    const [artRows] = await pool.query(
      `SELECT id, name, image AS image_url FROM artists WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [artistId]
    );
    if (artRows.length === 0) {
      return res.status(404).json({ message: 'Artist not found' });
    }
    const artist = artRows[0];
    const img = artist.image_url;
    const formattedImg = img
      ? (img.startsWith('http') || img.startsWith('data:') ? img : `${host}${img.startsWith('/') ? '' : '/'}${img}`)
      : null;

    // 2. Types (Singer, Lyrics, Music)
    const [[singerRes], [lyricsRes], [musicRes]] = await Promise.all([
      pool.query(`SELECT 1 FROM songSinger WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL) LIMIT 1`, [artistId]),
      pool.query(`SELECT 1 FROM songLyrics WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL) LIMIT 1`, [artistId]),
      pool.query(`SELECT 1 FROM songmusician WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL) LIMIT 1`, [artistId])
    ]);
    const types = [];
    if (singerRes.length) types.push('Singer');
    if (lyricsRes.length) types.push('Lyrics');
    if (musicRes.length) types.push('Music');

    // 3. Distinct active songs for this artist (main artist only)
    const [songRows] = await pool.query(`
      SELECT DISTINCT s.id, s.name, s.nameSinhala, s.isrcCode,
             s.is_recordlabel, s.is_lyrics, s.is_musician
      FROM songs s
      WHERE s.status = 1 AND s.is_delete = 0
        AND s.id IN (
          SELECT song_id FROM songSinger WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL)
          UNION
          SELECT song_id FROM songLyrics WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL)
          UNION
          SELECT song_id FROM songmusician WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL)
        )
      ORDER BY s.id DESC
    `, [artistId, artistId, artistId]);

    if (songRows.length === 0) {
      return res.json({
        artist: { id: artist.id, name: toTitleCase(artist.name), image_url: formattedImg, types },
        metrics: {
          totalSongs: 0, distributedSongs: 0, undistributedSongs: 0,
          grossIncome: 0, totalEarning: 0, totalOutgoing: 0,
          distributionPct: 30, artistAmount: 0, artistSongCount: 0, otherArtistAmount: 0, ourAmount: 0,
          distributorAmount: 0, distributorAmountFmt: '$0',
          latestPeriod: 'N/A', latestAmount: 0
        },
        ownershipCards: [
          { songsCount: 0, pct: '100%', label: 'Label + Music + Lyrics' },
          { songsCount: 0, pct: '75%', label: 'Label + Music' },
          { songsCount: 0, pct: '75%', label: 'Label + Lyrics' },
          { songsCount: 0, pct: '50%', label: 'Label' },
          { songsCount: 0, pct: '25%', label: 'Music or Lyrics' }
        ],
        songs: [],
        history: []
      });
    }

    const songIds = songRows.map(s => s.id);

    // 4. Check distributed vs undistributed songs (active songdistributor record: status=1, is_delete=0)
    const [distRows] = await pool.query(
      `SELECT DISTINCT song_id FROM songdistributor WHERE song_id IN (?) AND status = 1 AND is_delete = 0`,
      [songIds]
    );
    const distributedSongIds = new Set(distRows.map(d => d.song_id));
    const distributedSongs = distributedSongIds.size;
    const undistributedSongs = songRows.length - distributedSongs;

    // 5. Calculate Ownership shared breakdown for these songs
    let c100 = 0, c75_music = 0, c75_lyrics = 0, c50 = 0, c25 = 0;
    songRows.forEach(s => {
      const isRec = (s.is_recordlabel === 1 || s.is_recordlabel === true || s.is_recordlabel === '1') ? 50 : 0;
      const isLyr = (s.is_lyrics === 1 || s.is_lyrics === true || s.is_lyrics === '1') ? 25 : 0;
      const isMus = (s.is_musician === 1 || s.is_musician === true || s.is_musician === '1') ? 25 : 0;
      const totalPct = isRec + isLyr + isMus;

      if (totalPct === 100) c100++;
      else if (isRec === 50 && isMus === 25) c75_music++;
      else if (isRec === 50 && isLyr === 25) c75_lyrics++;
      else if (isRec === 50) c50++;
      else if (totalPct === 25) c25++;
      else c50++; // default fallback
    });

    const ownershipCards = [
      { songsCount: c100, pct: '100%', label: 'Label + Music + Lyrics' },
      { songsCount: c75_music, pct: '75%', label: 'Label + Music' },
      { songsCount: c75_lyrics, pct: '75%', label: 'Label + Lyrics' },
      { songsCount: c50, pct: '50%', label: 'Label' },
      { songsCount: c25, pct: '25%', label: 'Music or Lyrics' }
    ];

    // 6. Revenue totals and co-artist sharing
    const [revRows] = await pool.query(`
      SELECT id, song_id, song_name, date, amount, distributor_amount, remain_revenue, created_at
      FROM revenue
      WHERE song_id IN (?) AND status = 1 AND is_delete = 0
      ORDER BY date DESC, created_at DESC
    `, [songIds]);

    // Fetch main artist mappings per song for songSinger, songLyrics, songmusician
    const [mainRoles] = await pool.query(`
      SELECT song_id, 'singer' AS role, artist_id, COALESCE(is_main, 0) AS is_main
      FROM songSinger WHERE song_id IN (?) AND status=1 AND is_delete=0
      UNION ALL
      SELECT song_id, 'lyricist' AS role, artist_id, COALESCE(is_main, 0) AS is_main
      FROM songLyrics WHERE song_id IN (?) AND status=1 AND is_delete=0
      UNION ALL
      SELECT song_id, 'musician' AS role, artist_id, COALESCE(is_main, 0) AS is_main
      FROM songmusician WHERE song_id IN (?) AND status=1 AND is_delete=0
    `, [songIds, songIds, songIds]);

    const songRoleMap = {};
    mainRoles.forEach(r => {
      if (!songRoleMap[r.song_id]) {
        songRoleMap[r.song_id] = { singers: [], lyricists: [], musicians: [] };
      }
      if (r.role === 'singer') songRoleMap[r.song_id].singers.push(r);
      else if (r.role === 'lyricist') songRoleMap[r.song_id].lyricists.push(r);
      else if (r.role === 'musician') songRoleMap[r.song_id].musicians.push(r);
    });

    // Helper to compute artist's exact share of outgoing revenue for a song
    const computeArtistShare = (sId, targetArtistId, songOut) => {
      const roles = songRoleMap[sId] || { singers: [], lyricists: [], musicians: [] };
      let totalShares = 0;
      let targetShares = 0;

      const calcRoleShare = (roleList) => {
        if (roleList.length === 0) return { roleTotal: 0, targetRole: 0 };
        const mains = roleList.filter(r => r.is_main === 1);
        const activeList = mains.length > 0 ? mains : roleList;
        const targetMatch = activeList.find(r => String(r.artist_id) === String(targetArtistId));
        if (targetMatch) {
          return { roleTotal: 1, targetRole: 1 / activeList.length };
        }
        return { roleTotal: 1, targetRole: 0 };
      };

      const sRes = calcRoleShare(roles.singers);
      const lRes = calcRoleShare(roles.lyricists);
      const mRes = calcRoleShare(roles.musicians);

      const categoriesCount = (sRes.roleTotal > 0 ? 1 : 0) + (lRes.roleTotal > 0 ? 1 : 0) + (mRes.roleTotal > 0 ? 1 : 0);
      if (categoriesCount === 0) return { thisShare: 0, otherShare: songOut };

      const categoryWeight = songOut / categoriesCount;
      const targetCatShare = (sRes.targetRole * categoryWeight) + (lRes.targetRole * categoryWeight) + (mRes.targetRole * categoryWeight);

      return {
        thisShare: targetCatShare,
        otherShare: songOut - targetCatShare
      };
    };

    let grossIncome = 0;
    let totalEarning = 0;
    let totalDistributor = 0; // 30% distributor cut, sum of revenue.distributor_amount

    const songRevSum = {};

    revRows.forEach(r => {
      const amt = parseFloat(r.amount) || 0;
      const remain = parseFloat(r.remain_revenue);
      const earn = !isNaN(remain) ? remain : amt;
      const distAmt = r.distributor_amount !== null && r.distributor_amount !== undefined
        ? parseFloat(r.distributor_amount)
        : amt * 0.30;

      grossIncome += amt;
      totalEarning += earn;
      totalDistributor += distAmt;

      if (!songRevSum[r.song_id]) songRevSum[r.song_id] = { income: 0, earning: 0, distributor: 0 };
      songRevSum[r.song_id].income += amt;
      songRevSum[r.song_id].earning += earn;
      songRevSum[r.song_id].distributor += distAmt;
    });

    // Song count = all unique songs associated with this artist (singer + lyrics + musician tables)
    const artistSongCount = songRows.length;

    // Three-way split: Artist Amount + Other Artist Amount + Our Amount = Net Revenue per song.
    //
    // Artist Amount    – shares going to the SELECTED artist (lyrics/musician role, flag = 0)
    // Other Artist Amt – external shares going to OTHER artists (flag = 0, excl. selected artist)
    // Our Amount       – shares owned by us (flag = 1)
    //
    // Identity: artistAmount + otherArtistAmount + ourAmount === netRevenue (per song)
    let artistAmount = 0;
    let otherArtistAmount = 0;
    let ourAmount = 0;

    songRows.forEach(song => {
      const sId = song.id;
      const roles = songRoleMap[sId] || { singers: [], lyricists: [], musicians: [] };

      // Determine if selected artist is main lyrics artist (explicit is_main=1 takes priority, else all)
      const lyrMains = roles.lyricists.filter(r => r.is_main === 1);
      const lyrActive = lyrMains.length > 0 ? lyrMains : roles.lyricists;
      const isMainLyricsArtist = lyrActive.some(r => String(r.artist_id) === String(artistId));

      // Determine if selected artist is main musician artist
      const musMains = roles.musicians.filter(r => r.is_main === 1);
      const musActive = musMains.length > 0 ? musMains : roles.musicians;
      const isMainMusicianArtist = musActive.some(r => String(r.artist_id) === String(artistId));

      const revData = songRevSum[sId] || { income: 0 };
      // Net Revenue = 70% of gross income (after the fixed 30% distributor cut).
      // Using income * 0.70 (not income - stored_distributor_amount) ensures the
      // displayed cards always satisfy: Gross = Distributor(30%) + Artist + Other + Our.
      const netRevenue = revData.income * 0.70;

      const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1');
      const isLyr = (song.is_lyrics === 1 || song.is_lyrics === true || song.is_lyrics === '1');
      const isMus = (song.is_musician === 1 || song.is_musician === true || song.is_musician === '1');

      // --- Artist Amount: selected artist's direct share ---
      // Singer role contributes no direct percentage.
      if (isMainLyricsArtist && !isLyr) artistAmount += 0.25 * netRevenue;
      if (isMainMusicianArtist && !isMus) artistAmount += 0.25 * netRevenue;

      // --- Other Artist Amount: external shares NOT belonging to the selected artist ---
      // Record label share is always "other" (never the selected artist's share).
      if (!isRec) otherArtistAmount += 0.5 * netRevenue;
      // Lyrics share is "other" only when the selected artist is NOT the main lyrics artist.
      if (!isLyr && !isMainLyricsArtist) otherArtistAmount += 0.25 * netRevenue;
      // Musician share is "other" only when the selected artist is NOT the main musician artist.
      if (!isMus && !isMainMusicianArtist) otherArtistAmount += 0.25 * netRevenue;

      // --- Our Amount: shares owned by us (flag = 1) ---
      if (isRec) ourAmount += 0.5 * netRevenue;
      if (isLyr) ourAmount += 0.25 * netRevenue;
      if (isMus) ourAmount += 0.25 * netRevenue;
    });

    const totalOutgoing = grossIncome - totalEarning;
    const distributionPct = 30; // Fixed distributor share rate

    // 7. Get latest paid period to filter unpaid revenues
    const [latestPayment] = await pool.query(
      `SELECT period_label FROM artist_payments
       WHERE artist_id = ? AND status = 1 AND is_delete = 0
       ORDER BY paid_at DESC LIMIT 1`,
      [artistId]
    );
    const latestPaidDate = latestPayment.length > 0 ? latestPayment[0].period_label : null;

    // Filter to only UNPAID revenues (those after the latest paid period)
    const unpaidRevRows = latestPaidDate
      ? revRows.filter(r => String(r.date).slice(0, 10) > latestPaidDate)
      : revRows;

    // Latest period amount (from unpaid revenues only)
    let latestPeriod = 'N/A';
    let latestRevenueDate = 'N/A';
    let latestAmount = 0;
    let latestPaid = false;
    let latestSongCountFinal = 0;
    let hasUnpaidRevenue = false;
    
    if (unpaidRevRows.length > 0) {
      const latestDateStr = unpaidRevRows[0].date ? String(unpaidRevRows[0].date).slice(0, 10) : '';
      if (latestDateStr) {
        // Format: YYYY-MM-DD. Use local date components (not toISOString) to avoid
        // UTC timezone shifts rolling the date back by one day.
        const latestD = new Date(latestDateStr + 'T00:00:00');
        const prevMonth = new Date(latestD);
        prevMonth.setMonth(prevMonth.getMonth() - 1);
        const fmtD = (d) => {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${y}-${m}-${day}`;
        };
        latestPeriod = `${fmtD(prevMonth)} to ${fmtD(latestD)}`;
        latestRevenueDate = latestDateStr;  // Store the latest date for mark-as-paid
      }

      // Compute latest batch artist share using ownership-flag logic (consistent with main cards)
      const latestBatchDate = unpaidRevRows[0].date;
      const latestBatchSongRevSum = {};
      unpaidRevRows.filter(r => String(r.date) === String(latestBatchDate)).forEach(r => {
        const amt = parseFloat(r.amount) || 0;
        if (!latestBatchSongRevSum[r.song_id]) latestBatchSongRevSum[r.song_id] = 0;
        latestBatchSongRevSum[r.song_id] += amt;
      });

      let latestSongCount = 0;
      Object.keys(latestBatchSongRevSum).forEach(sIdStr => {
        const sId = parseInt(sIdStr, 10);
        const song = songRows.find(s => s.id === sId);
        if (!song) return;
        const roles = songRoleMap[sId] || { singers: [], lyricists: [], musicians: [] };
        const lyrMains = roles.lyricists.filter(r => r.is_main === 1);
        const lyrActive = lyrMains.length > 0 ? lyrMains : roles.lyricists;
        const isMainLyricsArtist = lyrActive.some(r => String(r.artist_id) === String(artistId));
        const musMains = roles.musicians.filter(r => r.is_main === 1);
        const musActive = musMains.length > 0 ? musMains : roles.musicians;
        const isMainMusicianArtist = musActive.some(r => String(r.artist_id) === String(artistId));
        const net = latestBatchSongRevSum[sId] * 0.70;
        const isLyr = (song.is_lyrics === 1 || song.is_lyrics === true || song.is_lyrics === '1');
        const isMus = (song.is_musician === 1 || song.is_musician === true || song.is_musician === '1');
        let share = 0;
        if (isMainLyricsArtist && !isLyr) share += 0.25 * net;
        if (isMainMusicianArtist && !isMus) share += 0.25 * net;
        if (share > 0) {
          latestAmount += share;
          latestSongCount++;
        }
      });

      if (latestAmount > 0) {
        latestPaid = false;  // Unpaid revenues by definition
        latestSongCountFinal = latestSongCount;
        hasUnpaidRevenue = true;
      }
    }

    const fmtUSD = (v) => `$${(parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    // 8. Build song list
    const songs = songRows.map(song => {
      const r = songRevSum[song.id] || { income: 0, earning: 0 };
      const out = r.income - r.earning;
      const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1') ? 50 : 0;
      const isLyr = (song.is_lyrics === 1 || song.is_lyrics === true || song.is_lyrics === '1') ? 25 : 0;
      const isMus = (song.is_musician === 1 || song.is_musician === true || song.is_musician === '1') ? 25 : 0;
      const ownershipPct = isRec + isLyr + isMus;
      return {
        id: song.id,
        name: toTitleCase(song.name),
        nameSinhala: song.nameSinhala || song.name,
        isrcCode: song.isrcCode || '—',
        ownership: ownershipPct,
        income: fmtUSD(r.income),
        earning: fmtUSD(r.earning),
        outgoing: fmtUSD(out),
        revenueAmount: r.income
      };
    });

    // 9. Payment history — log of Mark as Paid events for this artist
    const [paymentRows] = await pool.query(
      `SELECT id, amount, songs_count, period_label, paid_at
       FROM artist_payments
       WHERE artist_id = ? AND status = 1 AND is_delete = 0
       ORDER BY paid_at DESC`,
      [artistId]
    );

    const history = paymentRows.map(p => {
      const d = new Date(p.paid_at);
      const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' });
      return {
        date: dateLabel,
        periodLabel: p.period_label || '',
        amount: parseFloat(p.amount) || 0,
        amountFmt: `$${Math.round(parseFloat(p.amount) || 0)}`,
        songsCount: p.songs_count || 0
      };
    });

    res.json({
      artist: { id: artist.id, name: toTitleCase(artist.name), image_url: formattedImg, types },
      metrics: {
        totalSongs: songRows.length,
        distributedSongs,
        undistributedSongs,
        grossIncome: Math.round(grossIncome),
        totalEarning: Math.round(totalEarning),
        totalOutgoing: Math.round(totalOutgoing),
        distributionPct,
        artistAmount: Math.round(artistAmount),
        artistSongCount,
        otherArtistAmount: Math.round(otherArtistAmount),
        ourAmount: Math.round(ourAmount),
        distributorAmount: Math.round(grossIncome * 0.30),
        latestPeriod,
        latestAmount: Math.round(latestAmount),
        latestSongCount: latestSongCountFinal,
        latestPaid,
        hasUnpaidRevenue,
        latestRevenueDate,
        grossIncomeFmt: `$${Math.round(grossIncome)}`,
        totalEarningFmt: `$${Math.round(totalEarning)}`,
        totalOutgoingFmt: `$${Math.round(totalOutgoing)}`,
        artistAmountFmt: `$${Math.round(artistAmount)}`,
        artistSongCountFmt: artistSongCount,
        otherArtistAmountFmt: `$${Math.round(otherArtistAmount)}`,
        ourAmountFmt: `$${Math.round(ourAmount)}`,
        distributorAmountFmt: `$${Math.round(grossIncome * 0.30)}`,
        latestAmountFmt: `$${Math.round(latestAmount)}`
      },
      ownershipCards,
      songs,
      history
    });
  } catch (err) {
    console.error('Error fetching artist revenue details:', err);
    res.status(500).json({ message: 'Failed to load artist revenue details' });
  }
};

// POST /api/revenue/artist/:id/mark-paid
exports.markArtistAsPaid = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);
    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    const { amount, songsCount, periodLabel } = req.body;
    const payAmount = parseFloat(amount) || 0;
    const paySongsCount = parseInt(songsCount, 10) || 0;
    const payPeriodLabel = periodLabel || null;

    if (payAmount <= 0) {
      return res.status(400).json({ message: 'Amount must be greater than zero' });
    }

    // Guard: prevent duplicate payment for the same period
    if (payPeriodLabel) {
      const [existing] = await pool.query(
        `SELECT id FROM artist_payments WHERE artist_id = ? AND period_label = ? AND status = 1 AND is_delete = 0 LIMIT 1`,
        [artistId, payPeriodLabel]
      );
      if (existing.length > 0) {
        return res.status(409).json({ message: 'This period has already been marked as paid' });
      }
    }

    await pool.query(
      `INSERT INTO artist_payments (artist_id, amount, songs_count, period_label) VALUES (?, ?, ?, ?)`,
      [artistId, payAmount, paySongsCount, payPeriodLabel]
    );

    res.json({
      success: true,
      message: 'Artist payment recorded successfully'
    });
  } catch (err) {
    console.error('Error marking artist as paid:', err);
    res.status(500).json({ message: 'Failed to record artist payment' });
  }
};

exports.getArtistSongs = async (req, res) => {
  try {
    const pool = getPool();
    const artistId = parseInt(req.params.id, 10);
    if (isNaN(artistId)) {
      return res.status(400).json({ message: 'Invalid artist ID' });
    }

    // 1. Distinct active songs where this artist is the main artist (singer, lyrics, or musician)
    const [songRows] = await pool.query(`
      SELECT DISTINCT s.id, s.name, s.nameSinhala, s.isrcCode,
             s.is_recordlabel, s.is_lyrics, s.is_musician
      FROM songs s
      WHERE s.status = 1 AND s.is_delete = 0
        AND s.id IN (
          SELECT song_id FROM songSinger WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL)
          UNION
          SELECT song_id FROM songLyrics WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL)
          UNION
          SELECT song_id FROM songmusician WHERE artist_id = ? AND status=1 AND is_delete=0 AND (is_main = 1 OR is_main IS NULL)
        )
      ORDER BY s.id DESC
    `, [artistId, artistId, artistId]);

    if (songRows.length === 0) {
      return res.json({ songs: [], totalSongs: 0 });
    }

    const songIds = songRows.map(s => s.id);

    // 2. Revenue sums per song (Income, Distributor 30%, Earning, Outgoing) — same as getRevenueData
    const [revenueSumRows] = await pool.query(`
      SELECT r.song_id,
             SUM(r.amount) AS total_income,
             SUM(COALESCE(r.distributor_amount, r.amount * 0.30)) AS total_distributor,
             SUM(COALESCE(r.remain_revenue, (r.amount * 0.70))) AS total_earning,
             SUM(r.amount - COALESCE(r.distributor_amount, r.amount * 0.30) - COALESCE(r.remain_revenue, (r.amount * 0.70))) AS total_outgoing
      FROM revenue r
      WHERE r.song_id IN (?) AND r.status = 1 AND r.is_delete = 0
      GROUP BY r.song_id
    `, [songIds]);

    // 3. Singer relations for these songs (to build "Artist" / "Artist Sub" columns)
    const [artistRelations] = await pool.query(`
      SELECT ss.song_id, a.name AS artist_name
      FROM songSinger ss
      INNER JOIN artists a ON ss.artist_id = a.id AND (a.is_delete = 0 OR a.is_delete IS NULL)
      WHERE ss.song_id IN (?) AND ss.status = 1 AND ss.is_delete = 0
    `, [songIds]);

    const revenueSumMap = {};
    revenueSumRows.forEach(r => {
      revenueSumMap[r.song_id] = {
        income: parseFloat(r.total_income) || 0,
        distributor: parseFloat(r.total_distributor) || 0,
        earning: parseFloat(r.total_earning) || 0,
        outgoing: parseFloat(r.total_outgoing) || 0
      };
    });

    const songSingersMap = {};
    artistRelations.forEach(rel => {
      if (!songSingersMap[rel.song_id]) songSingersMap[rel.song_id] = [];
      songSingersMap[rel.song_id].push(rel.artist_name);
    });

    const fmtDollar = (val) => val > 0 ? `$${val.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$0.00';

    const formattedSongs = songRows.map(song => {
      const revStats = revenueSumMap[song.id] || { income: 0, distributor: 0, earning: 0, outgoing: 0 };
      const singers = songSingersMap[song.id] || [];

      const isRec = (song.is_recordlabel === 1 || song.is_recordlabel === true || song.is_recordlabel === '1') ? 50 : 0;
      const isLyr = (song.is_lyrics === 1 || song.is_lyrics === true || song.is_lyrics === '1') ? 25 : 0;
      const isMus = (song.is_musician === 1 || song.is_musician === true || song.is_musician === '1') ? 25 : 0;
      const ownershipRaw = isRec + isLyr + isMus;

      return {
        id: song.id,
        name: toTitleCase(song.name),
        nameSinhala: song.nameSinhala || song.name,
        isrcCode: song.isrcCode || '—',
        income: fmtDollar(revStats.income),
        distributor: fmtDollar(revStats.distributor),
        earning: fmtDollar(revStats.earning),
        outgoing: fmtDollar(revStats.outgoing),
        totalRevenue: fmtDollar(revStats.income),
        revenueAmount: revStats.income,
        artist: singers.length > 0 ? singers.join(', ') : '—',
        artistSub: singers.length > 1 ? singers.slice(1).join(', ') : '',
        ownership: ownershipRaw
      };
    });

    res.json({
      songs: formattedSongs,
      totalSongs: formattedSongs.length
    });
  } catch (err) {
    console.error('Error fetching artist songs:', err);
    res.status(500).json({ message: 'Failed to fetch artist songs' });
  }
};
