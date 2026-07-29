const { getPool } = require('../config/db');
const { createAuditLog } = require('../utils/auditLogger');

// Helper to reliably format date values into YYYY-MM-DD strings
function formatYMD(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
      return d.slice(0, 10);
    }
  }
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(d).slice(0, 10);
}

// GET /api/calendar/events (Get all events: Custom events, Case Situation stages, Notes)
exports.getEvents = async (req, res) => {
  try {
    const pool = getPool();

    // 1. Fetch Custom Calendar Events
    const [calRows] = await pool.query(
      `SELECT id, event_name, description, event_date, event_time, 'event' as type
       FROM calendar_event 
       WHERE (is_delete = 0 OR is_delete IS NULL)
       ORDER BY event_date ASC, event_time ASC`
    );

    // 2. Fetch Active Notes (Only Notes, Cases are represented by their Situation Stages)
    const [ncRows] = await pool.query(
      `SELECT id, type, name as event_name, description, start_date, '09:00' as event_time, status
       FROM notesandcases
       WHERE is_delete = 0 AND type = 'note'`
    );

    // 3. Fetch Case Situation Stages
    const [sitRows] = await pool.query(
      `SELECT s.id, s.notesandcase_id, s.order_id, s.description, 
              s.start_date, s.end_date,
              '09:00' as event_time,
              nc.name as case_name
       FROM situation s
       JOIN notesandcases nc ON s.notesandcase_id = nc.id
       WHERE s.is_delete = 0 AND nc.is_delete = 0 AND nc.type = 'case'`
    );

    // Format Notes as calendar events
    const ncEvents = ncRows.map(nc => {
      const sDate = formatYMD(nc.start_date);
      return {
        id: `note_${nc.id}`,
        original_id: nc.id,
        event_name: `Note: ${nc.event_name}`,
        description: nc.description,
        event_date: sDate,
        start_date: sDate,
        end_date: sDate,
        event_time: nc.event_time || '09:00',
        type: 'note',
        category: 'Note',
        color: '#10b981',
        bg_color: '#ecfdf5',
        text_color: '#059669'
      };
    });

    // Format Case Situation Stages using situation's start_date and end_date
    const sitEvents = sitRows.map(s => {
      const stageLabel = s.order_id === 1 ? 'start' : String(s.order_id).padStart(2, '0');
      const descSnippet = s.description ? `: ${s.description}` : '';
      const stageName = `${s.case_name} - Stage ${stageLabel}${descSnippet}`;
      const sDate = formatYMD(s.start_date);
      const eDate = formatYMD(s.end_date) || sDate;

      return {
        id: `sit_${s.id}`,
        original_id: s.id,
        notesandcase_id: s.notesandcase_id,
        event_name: stageName,
        case_name: s.case_name,
        description: s.description,
        event_date: sDate,
        start_date: sDate,
        end_date: eDate,
        event_time: '09:00',
        type: 'situation',
        category: 'Situation Stage',
        color: '#8b5cf6',
        bg_color: '#f5f3ff',
        text_color: '#7c3aed'
      };
    });

    const formattedCalEvents = calRows.map(e => {
      const eDate = formatYMD(e.event_date);
      return {
        ...e,
        id: e.id,
        original_id: e.id,
        event_date: eDate,
        start_date: eDate,
        end_date: eDate,
        type: 'event',
        category: 'Calendar Event',
        color: '#0b66e3',
        bg_color: '#eff6ff',
        text_color: '#0b66e3'
      };
    });

    const allEvents = [...formattedCalEvents, ...ncEvents, ...sitEvents];

    res.json({
      events: allEvents,
      totalCount: allEvents.length
    });
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/calendar/events (Create new event)
exports.createEvent = async (req, res) => {
  try {
    const pool = getPool();
    const { event_name, event_date, event_time, description } = req.body;

    if (!event_name || !event_name.trim()) {
      return res.status(400).json({ message: 'Event Name is required.' });
    }
    if (!event_date) {
      return res.status(400).json({ message: 'Date is required.' });
    }
    if (!event_time) {
      return res.status(400).json({ message: 'Time is required.' });
    }

    const [result] = await pool.query(
      `INSERT INTO calendar_event (event_name, description, event_date, event_time, is_delete)
       VALUES (?, ?, ?, ?, 0)`,
      [event_name.trim(), description ? description.trim() : null, event_date, event_time]
    );

    const [newRows] = await pool.query(
      `SELECT id, event_name, description, DATE_FORMAT(event_date, '%Y-%m-%d') as event_date, event_time, is_delete, created_at, updated_at FROM calendar_event WHERE id = ?`,
      [result.insertId]
    );

    await createAuditLog({
      user: req.user || null,
      action: 'CREATE_CALENDAR_EVENT',
      details: `Created calendar event ${event_name.trim()}`
    });

    res.status(201).json({
      message: 'Event created successfully.',
      event: newRows[0]
    });
  } catch (error) {
    console.error('Error creating calendar event:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /api/calendar/events/:id (Update event)
exports.updateEvent = async (req, res) => {
  try {
    const pool = getPool();
    const rawId = String(req.params.id).replace(/^(evt_|note_|sit_)/, '');
    const id = parseInt(rawId, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const { event_name, event_date, event_time, description } = req.body;

    if (!event_name || !event_name.trim()) {
      return res.status(400).json({ message: 'Event Name is required.' });
    }
    if (!event_date) {
      return res.status(400).json({ message: 'Date is required.' });
    }
    if (!event_time) {
      return res.status(400).json({ message: 'Time is required.' });
    }

    await pool.query(
      `UPDATE calendar_event SET
        event_name = ?,
        description = ?,
        event_date = ?,
        event_time = ?
      WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [event_name.trim(), description ? description.trim() : null, event_date, event_time, id]
    );

    const [updatedRows] = await pool.query(
      `SELECT id, event_name, description, DATE_FORMAT(event_date, '%Y-%m-%d') as event_date, event_time, is_delete, created_at, updated_at FROM calendar_event WHERE id = ?`,
      [id]
    );

    await createAuditLog({
      user: req.user || null,
      action: 'UPDATE_CALENDAR_EVENT',
      details: `Updated calendar event ${event_name.trim()}`
    });

    res.json({
      message: 'Event updated successfully.',
      event: updatedRows[0]
    });
  } catch (error) {
    console.error('Error updating calendar event:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /api/calendar/events/:id (Soft delete event by setting is_delete = 1)
exports.deleteEvent = async (req, res) => {
  try {
    const pool = getPool();
    const rawId = String(req.params.id).replace(/^(evt_|note_|sit_)/, '');
    const id = parseInt(rawId, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    await pool.query('UPDATE calendar_event SET is_delete = 1 WHERE id = ?', [id]);
    await createAuditLog({
      user: req.user || null,
      action: 'DELETE_CALENDAR_EVENT',
      details: `Deleted calendar event ID ${id}`
    });

    res.json({ message: 'Event deleted successfully.' });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
