const { getPool } = require('../config/db');

async function createAuditLog({ user, action, details, ipAddress = null }) {
  try {
    const pool = getPool();
    const resolvedUser = user || null;
    const userId = resolvedUser && resolvedUser.id ? resolvedUser.id : null;
    const email = resolvedUser && resolvedUser.email ? resolvedUser.email : (resolvedUser && resolvedUser.username ? resolvedUser.username : 'System');
    const username = resolvedUser && resolvedUser.username ? resolvedUser.username : 'System';

    await pool.query(
      `INSERT INTO user_logs (user_id, username, action, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
      [userId, email, action, details, ipAddress || '127.0.0.1']
    );
  } catch (err) {
    console.error('Error logging user activity:', err);
  }
}

module.exports = {
  createAuditLog,
};
