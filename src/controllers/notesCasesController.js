const { getPool } = require('../config/db');
const ExcelJS = require('exceljs');

function formatDate(d) {
  if (!d) return null;
  if (typeof d === 'object' && d instanceof Date) {
    return d.toISOString().split('T')[0];
  }
  return String(d).split('T')[0];
}

// ─────────────────────────────────────────────────────────
// GET /notes-and-cases
// ─────────────────────────────────────────────────────────
exports.getNotesCases = async (req, res) => {
  try {
    const pool = getPool();
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const offset = (page - 1) * limit;

    const statusParam = req.query.status;
    const typeParam = req.query.type;
    const searchQuery = (req.query.search || req.query.q || '').trim();
    const isExport = req.query.export === 'true' || req.query.isExport === 'true';

    // Build WHERE clause
    const conditions = ['nc.is_delete = 0'];
    const params = [];

    if (statusParam === 'open' || statusParam === '1' || statusParam === 1) {
      conditions.push('nc.status = 1');
    } else if (statusParam === 'closed' || statusParam === '0' || statusParam === 0) {
      conditions.push('nc.status = 0');
    } else {
      // Default to open records (status = 1, is_delete = 0)
      conditions.push('nc.status = 1');
    }

    if (typeParam && (typeParam === 'note' || typeParam === 'case')) {
      conditions.push('nc.type = ?');
      params.push(typeParam);
    }

    if (searchQuery) {
      conditions.push('(nc.name LIKE ? OR nc.tags LIKE ? OR nc.description LIKE ?)');
      const term = `%${searchQuery}%`;
      params.push(term, term, term);
    }

    const whereClause = conditions.join(' AND ');

    // 1. Total Count Query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM notesandcases nc WHERE ${whereClause}`,
      params
    );
    const totalCount = countRows[0].total;

    // 2. Data Query
    let dataQuery = `
      SELECT nc.id, nc.type, nc.name, nc.description, nc.tags, nc.priority,
             nc.link_type, nc.link_result, nc.start_date, nc.end_date,
             nc.status, nc.is_delete, nc.created_at, nc.updated_at
      FROM notesandcases nc
      WHERE ${whereClause}
      ORDER BY nc.created_at DESC, nc.id DESC
    `;

    let rows;
    if (isExport) {
      [rows] = await pool.query(dataQuery, params);
    } else {
      dataQuery += ` LIMIT ? OFFSET ?`;
      [rows] = await pool.query(dataQuery, [...params, limit, offset]);
    }

    // Fetch related active situations for case items
    const caseIds = rows.filter(r => r.type === 'case').map(r => r.id);
    let situationsMap = {};

    if (caseIds.length > 0) {
      const placeholders = caseIds.map(() => '?').join(',');
      const [sitRows] = await pool.query(
        `SELECT id, notesandcase_id, order_id, description, start_date, end_date, status, is_delete
         FROM situation
         WHERE notesandcase_id IN (${placeholders}) AND is_delete = 0
         ORDER BY order_id ASC, id ASC`,
        caseIds
      );

      sitRows.forEach(s => {
        if (!situationsMap[s.notesandcase_id]) {
          situationsMap[s.notesandcase_id] = [];
        }
        situationsMap[s.notesandcase_id].push({
          id: s.id,
          orderId: s.order_id,
          description: s.description,
          startDate: formatDate(s.start_date),
          endDate: formatDate(s.end_date),
          label: s.order_id === 1 ? 'start' : String(s.order_id).padStart(2, '0'),
          date: formatDate(s.start_date) || formatDate(s.created_at)
        });
      });
    }

    const items = rows.map(r => {
      const sits = situationsMap[r.id] || [];
      return {
        id: r.id,
        type: r.type,
        name: r.name,
        description: r.description || '',
        tags: r.tags || '',
        priority: r.priority || 'medium',
        linkType: r.link_type || '',
        link_type: r.link_type || '',
        linkResult: r.link_result || '',
        link_result: r.link_result || '',
        linkedValue: r.link_result || '',
        startDate: formatDate(r.start_date),
        start_date: formatDate(r.start_date),
        endDate: formatDate(r.end_date),
        end_date: formatDate(r.end_date),
        status: r.status,
        is_delete: r.is_delete,
        createdAt: r.created_at,
        currentSituation: sits.length > 0 ? sits[sits.length - 1].description : 'start',
        stages: sits,
        situations: sits
      };
    });

    res.json({
      items,
      records: items,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit) || 1
    });
  } catch (error) {
    console.error('Error fetching notes and cases:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// GET /notes-and-cases/search
// ─────────────────────────────────────────────────────────
exports.searchNotesCases = async (req, res) => {
  try {
    const pool = getPool();
    const query = (req.query.q || req.query.query || '').trim();

    if (!query) {
      return res.json({ items: [] });
    }

    const term = `%${query}%`;
    const [rows] = await pool.query(
      `SELECT id, type, name, description, tags, priority, link_type, link_result, start_date, end_date
       FROM notesandcases
       WHERE status = 1 AND is_delete = 0 AND (name LIKE ? OR tags LIKE ?)
       ORDER BY name ASC LIMIT 50`,
      [term, term]
    );

    res.json({
      items: rows.map(r => ({
        id: r.id,
        type: r.type,
        name: r.name,
        tags: r.tags || '',
        description: r.description || ''
      }))
    });
  } catch (error) {
    console.error('Error searching notes and cases:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// GET /notes-and-cases/export
// ─────────────────────────────────────────────────────────
exports.exportNotesCases = async (req, res) => {
  try {
    const pool = getPool();
    const statusParam = req.query.status;
    const typeParam = req.query.type;
    const searchQuery = (req.query.search || req.query.q || '').trim();

    const conditions = ['nc.is_delete = 0'];
    const params = [];

    if (statusParam === 'open' || statusParam === '1' || statusParam === 1) {
      conditions.push('nc.status = 1');
    } else if (statusParam === 'closed' || statusParam === '0' || statusParam === 0) {
      conditions.push('nc.status = 0');
    } else {
      conditions.push('nc.status = 1');
    }

    if (typeParam && (typeParam === 'note' || typeParam === 'case')) {
      conditions.push('nc.type = ?');
      params.push(typeParam);
    }

    if (searchQuery) {
      conditions.push('(nc.name LIKE ? OR nc.tags LIKE ? OR nc.description LIKE ?)');
      const term = `%${searchQuery}%`;
      params.push(term, term, term);
    }

    const whereClause = conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT nc.id, nc.type, nc.name, nc.description, nc.tags, nc.priority,
              nc.link_type, nc.link_result, nc.start_date, nc.end_date, nc.status
       FROM notesandcases nc
       WHERE ${whereClause}
       ORDER BY nc.created_at DESC`,
      params
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Notes & Cases');

    worksheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Priority', key: 'priority', width: 15 },
      { header: 'Tags', key: 'tags', width: 25 },
      { header: 'Description', key: 'description', width: 45 },
      { header: 'Link Type', key: 'link_type', width: 20 },
      { header: 'Link Result', key: 'link_result', width: 25 },
      { header: 'Start Date', key: 'start_date', width: 15 },
      { header: 'End Date', key: 'end_date', width: 15 },
      { header: 'Status', key: 'status', width: 12 }
    ];

    rows.forEach(r => {
      worksheet.addRow({
        id: r.id,
        type: (r.type || 'case').toUpperCase(),
        name: r.name,
        priority: (r.priority || 'medium').toUpperCase(),
        tags: r.tags || '—',
        description: r.description || '—',
        link_type: r.link_type || '—',
        link_result: r.link_result || '—',
        start_date: formatDate(r.start_date) || '—',
        end_date: formatDate(r.end_date) || '—',
        status: r.status === 1 ? 'Open' : 'Closed'
      });
    });

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFEFEF' }
    };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Notes_And_Cases_Report.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting notes and cases:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// GET /notes-and-cases/:id
// ─────────────────────────────────────────────────────────
exports.getNotesCaseById = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record ID' });
    }

    const [rows] = await pool.query(
      `SELECT id, type, name, description, tags, priority, link_type, link_result,
              start_date, end_date, status, is_delete, created_at, updated_at
       FROM notesandcases
       WHERE id = ? AND is_delete = 0`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Note or Case not found' });
    }

    const r = rows[0];

    // Fetch related active situations
    const [sitRows] = await pool.query(
      `SELECT id, notesandcase_id, order_id, description, start_date, end_date, status, is_delete
       FROM situation
       WHERE notesandcase_id = ? AND is_delete = 0
       ORDER BY order_id ASC, id ASC`,
      [id]
    );

    const situations = sitRows.map(s => ({
      id: s.id,
      orderId: s.order_id,
      description: s.description,
      startDate: formatDate(s.start_date),
      endDate: formatDate(s.end_date),
      label: s.order_id === 1 ? 'start' : String(s.order_id).padStart(2, '0'),
      date: formatDate(s.start_date) || formatDate(s.created_at)
    }));

    res.json({
      id: r.id,
      type: r.type,
      name: r.name,
      description: r.description || '',
      tags: r.tags || '',
      priority: r.priority || 'medium',
      linkType: r.link_type || '',
      link_type: r.link_type || '',
      linkResult: r.link_result || '',
      link_result: r.link_result || '',
      startDate: formatDate(r.start_date),
      start_date: formatDate(r.start_date),
      endDate: formatDate(r.end_date),
      end_date: formatDate(r.end_date),
      status: r.status,
      is_delete: r.is_delete,
      createdAt: r.created_at,
      stages: situations,
      situations
    });
  } catch (error) {
    console.error('Error fetching note/case details:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /notes-and-cases
// ─────────────────────────────────────────────────────────
exports.createNotesCase = async (req, res) => {
  try {
    const pool = getPool();
    const {
      type = 'case',
      name,
      description = '',
      tags = '',
      priority = 'medium',
      link_type,
      linkType,
      link_result,
      linkResult,
      linkValue,
      start_date,
      startDate,
      end_date,
      endDate,
      situations = [],
      stages = []
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const finalType = (type === 'note' || type === 'Note') ? 'note' : 'case';
    const finalPriority = ['high', 'medium', 'low', 'neutral'].includes(priority) ? priority : 'medium';
    const finalLinkType = link_type || linkType || null;
    const finalLinkResult = link_result || linkResult || linkValue || null;

    const todayStr = new Date().toISOString().split('T')[0];
    const finalStartDate = start_date || startDate || todayStr;
    const finalEndDate = finalType === 'case' ? (end_date || endDate || todayStr) : null;

    // 1. Insert main notesandcases record
    const [result] = await pool.query(
      `INSERT INTO notesandcases 
       (type, name, description, tags, priority, link_type, link_result, start_date, end_date, status, is_delete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      [finalType, name.trim(), description.trim(), tags.trim(), finalPriority, finalLinkType, finalLinkResult, finalStartDate, finalEndDate]
    );

    const createdId = result.insertId;

    // 2. Insert Situations if Type = Case
    const situationList = Array.isArray(situations) && situations.length > 0 ? situations : (Array.isArray(stages) ? stages : []);
    if (finalType === 'case' && situationList.length > 0) {
      for (let i = 0; i < situationList.length; i++) {
        const sit = situationList[i];
        const sDate = sit.start_date || sit.startDate || sit.date || todayStr;
        const eDate = sit.end_date || sit.endDate || sDate;
        const desc = sit.description || sit.desc || 'Initial situation logged.';

        await pool.query(
          `INSERT INTO situation (notesandcase_id, order_id, description, start_date, end_date, status, is_delete)
           VALUES (?, ?, ?, ?, ?, 1, 0)`,
          [createdId, i + 1, desc.trim(), sDate, eDate]
        );
      }
    }

    res.status(201).json({
      success: true,
      message: `${finalType === 'case' ? 'Case' : 'Note'} created successfully.`,
      id: createdId
    });
  } catch (error) {
    console.error('Error creating note/case:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// PUT /notes-and-cases/:id
// ─────────────────────────────────────────────────────────
exports.updateNotesCase = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record ID' });
    }

    const {
      type = 'case',
      name,
      description = '',
      tags = '',
      priority = 'medium',
      link_type,
      linkType,
      link_result,
      linkResult,
      linkValue,
      start_date,
      startDate,
      end_date,
      endDate,
      status,
      situations = [],
      stages = []
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const finalType = (type === 'note' || type === 'Note') ? 'note' : 'case';
    const finalPriority = ['high', 'medium', 'low', 'neutral'].includes(priority) ? priority : 'medium';
    const finalLinkType = link_type || linkType || null;
    const finalLinkResult = link_result || linkResult || linkValue || null;
    const finalStatus = status !== undefined ? (status == 1 || status === true || status === '1' ? 1 : 0) : 1;

    const todayStr = new Date().toISOString().split('T')[0];
    const finalStartDate = start_date || startDate || todayStr;
    const finalEndDate = finalType === 'case' ? (end_date || endDate || todayStr) : null;

    // 1. Update main notesandcases record
    await pool.query(
      `UPDATE notesandcases 
       SET type = ?, name = ?, description = ?, tags = ?, priority = ?,
           link_type = ?, link_result = ?, start_date = ?, end_date = ?, status = ?
       WHERE id = ? AND is_delete = 0`,
      [finalType, name.trim(), description.trim(), tags.trim(), finalPriority, finalLinkType, finalLinkResult, finalStartDate, finalEndDate, finalStatus, id]
    );

    // 2. Sync Situations if Type = Case
    const situationList = Array.isArray(situations) && situations.length > 0 ? situations : (Array.isArray(stages) ? stages : []);
    if (finalType === 'case') {
      // Soft-delete existing situations for this record first
      await pool.query(
        `UPDATE situation SET status = 0, is_delete = 1 WHERE notesandcase_id = ?`,
        [id]
      );

      // Re-insert or update current list
      for (let i = 0; i < situationList.length; i++) {
        const sit = situationList[i];
        const sDate = sit.start_date || sit.startDate || sit.date || todayStr;
        const eDate = sit.end_date || sit.endDate || sDate;
        const desc = sit.description || sit.desc || 'Situation logged.';

        await pool.query(
          `INSERT INTO situation (notesandcase_id, order_id, description, start_date, end_date, status, is_delete)
           VALUES (?, ?, ?, ?, ?, 1, 0)`,
          [id, i + 1, desc.trim(), sDate, eDate]
        );
      }
    }

    res.json({
      success: true,
      message: `${finalType === 'case' ? 'Case' : 'Note'} updated successfully.`
    });
  } catch (error) {
    console.error('Error updating note/case:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// DELETE /notes-and-cases/:id
// ─────────────────────────────────────────────────────────
exports.deleteNotesCase = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record ID' });
    }

    // Soft delete main record: set status = 0, is_delete = 1
    await pool.query(
      `UPDATE notesandcases SET status = 0, is_delete = 1 WHERE id = ?`,
      [id]
    );

    // Soft delete related situations
    await pool.query(
      `UPDATE situation SET status = 0, is_delete = 1 WHERE notesandcase_id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: 'Note or Case deleted successfully',
      id
    });
  } catch (error) {
    console.error('Error deleting note/case:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /notes-and-cases/:id/situations
// Add a single new situation to an existing case
// ─────────────────────────────────────────────────────────
exports.addSituation = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid record ID' });
    }

    // Check parent case status
    const [caseRows] = await pool.query(
      `SELECT status, is_delete FROM notesandcases WHERE id = ?`,
      [id]
    );
    if (caseRows.length === 0 || caseRows[0].is_delete === 1) {
      return res.status(404).json({ message: 'Case not found or has been deleted.' });
    }
    if (caseRows[0].status === 0) {
      return res.status(400).json({ message: 'Cannot add situations to a closed case.' });
    }

    const { start_date, end_date, description } = req.body;
    const todayStr = new Date().toISOString().split('T')[0];

    const sDate = start_date || todayStr;
    const eDate = end_date || sDate;
    const desc = (description || '').trim();

    if (!desc) {
      return res.status(400).json({ message: 'Description is required.' });
    }

    // Get next order_id for this case
    const [orderRows] = await pool.query(
      `SELECT COALESCE(MAX(order_id), 0) AS maxOrder FROM situation WHERE notesandcase_id = ? AND is_delete = 0`,
      [id]
    );
    const nextOrderId = (orderRows[0]?.maxOrder || 0) + 1;

    const [result] = await pool.query(
      `INSERT INTO situation (notesandcase_id, order_id, description, start_date, end_date, status, is_delete)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [id, nextOrderId, desc, sDate, eDate]
    );

    res.status(201).json({
      success: true,
      message: 'Situation added successfully.',
      situation: {
        id: result.insertId,
        notesandcase_id: id,
        order_id: nextOrderId,
        description: desc,
        start_date: sDate,
        end_date: eDate,
        label: nextOrderId === 1 ? 'start' : String(nextOrderId).padStart(2, '0')
      }
    });
  } catch (error) {
    console.error('Error adding situation:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// PUT /notes-and-cases/:id/situations/:sitId
// Update a situation's start_date, end_date, description
// ─────────────────────────────────────────────────────────
exports.updateSituation = async (req, res) => {
  try {
    const pool = getPool();
    const caseId = parseInt(req.params.id, 10);
    const sitId = parseInt(req.params.sitId, 10);
    if (isNaN(caseId) || isNaN(sitId)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    // Check parent case status
    const [caseRows] = await pool.query(
      `SELECT status, is_delete FROM notesandcases WHERE id = ?`,
      [caseId]
    );
    if (caseRows.length === 0 || caseRows[0].is_delete === 1) {
      return res.status(404).json({ message: 'Case not found or has been deleted.' });
    }
    if (caseRows[0].status === 0) {
      return res.status(400).json({ message: 'Cannot edit situations of a closed case.' });
    }

    const { start_date, end_date, description } = req.body;
    const todayStr = new Date().toISOString().split('T')[0];

    const desc = (description || '').trim();
    if (!desc) {
      return res.status(400).json({ message: 'Description is required.' });
    }

    const sDate = start_date || todayStr;
    const eDate = end_date || sDate;

    await pool.query(
      `UPDATE situation SET description = ?, start_date = ?, end_date = ? WHERE id = ? AND notesandcase_id = ? AND is_delete = 0`,
      [desc, sDate, eDate, sitId, caseId]
    );

    res.json({
      success: true,
      message: 'Situation updated successfully.',
      situation: { id: sitId, description: desc, start_date: sDate, end_date: eDate }
    });
  } catch (error) {
    console.error('Error updating situation:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// DELETE /notes-and-cases/:id/situations/:sitId
// Soft-delete a situation
// ─────────────────────────────────────────────────────────
exports.deleteSituation = async (req, res) => {
  try {
    const pool = getPool();
    const caseId = parseInt(req.params.id, 10);
    const sitId = parseInt(req.params.sitId, 10);
    if (isNaN(caseId) || isNaN(sitId)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    // Check parent case status
    const [caseRows] = await pool.query(
      `SELECT status, is_delete FROM notesandcases WHERE id = ?`,
      [caseId]
    );
    if (caseRows.length === 0 || caseRows[0].is_delete === 1) {
      return res.status(404).json({ message: 'Case not found or has been deleted.' });
    }
    if (caseRows[0].status === 0) {
      return res.status(400).json({ message: 'Cannot delete situations of a closed case.' });
    }

    await pool.query(
      `UPDATE situation SET status = 0, is_delete = 1 WHERE id = ? AND notesandcase_id = ?`,
      [sitId, caseId]
    );

    res.json({ success: true, message: 'Situation deleted successfully.', id: sitId });
  } catch (error) {
    console.error('Error deleting situation:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
