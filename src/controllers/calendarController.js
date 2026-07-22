const { getPool } = require('../config/db');

// GET /api/calendar/events (Get all active events with optional date / month filter)
exports.getEvents = async (req, res) => {
  try {
    const pool = getPool();
    const { date, month, year } = req.query;

    let whereClauses = ['(is_delete = 0 OR is_delete IS NULL)'];
    let queryParams = [];

    if (date) {
      whereClauses.push('event_date = ?');
      queryParams.push(date);
    } else if (month && year) {
      whereClauses.push('MONTH(event_date) = ? AND YEAR(event_date) = ?');
      queryParams.push(parseInt(month, 10), parseInt(year, 10));
    }

    const whereStr = 'WHERE ' + whereClauses.join(' AND ');
    const [rows] = await pool.query(
      `SELECT id, event_name, description, DATE_FORMAT(event_date, '%Y-%m-%d') as event_date, event_time, is_delete, created_at, updated_at
       FROM calendar_event ${whereStr} ORDER BY event_date ASC, event_time ASC`,
      queryParams
    );

    res.json({
      events: rows,
      totalCount: rows.length
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
    const id = parseInt(req.params.id, 10);
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
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    await pool.query('UPDATE calendar_event SET is_delete = 1 WHERE id = ?', [id]);
    res.json({ message: 'Event deleted successfully.' });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
