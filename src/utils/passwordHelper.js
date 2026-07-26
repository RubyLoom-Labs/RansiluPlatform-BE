const bcrypt = require('bcryptjs');
const { getPool } = require('../config/db');

/**
 * High Security Password Validation
 * Requirements: Minimum 8 characters, at least 1 uppercase, 1 lowercase, 1 number, and 1 special symbol.
 */
function validatePasswordSecurity(password) {
  if (!password || typeof password !== 'string') {
    return { isValid: false, message: 'Password is required.' };
  }

  const pass = password.trim();

  if (pass.length < 8) {
    return { isValid: false, message: 'Password must be at least 8 characters long.' };
  }

  if (!/[A-Z]/.test(pass)) {
    return { isValid: false, message: 'Password must contain at least one uppercase letter (A-Z).' };
  }

  if (!/[a-z]/.test(pass)) {
    return { isValid: false, message: 'Password must contain at least one lowercase letter (a-z).' };
  }

  if (!/[0-9]/.test(pass)) {
    return { isValid: false, message: 'Password must contain at least one number (0-9).' };
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pass)) {
    return { isValid: false, message: 'Password must contain at least one special symbol (!@#$%^&* etc.).' };
  }

  return { isValid: true };
}

/**
 * Check if the new password has been used before by this user (current password or password history)
 */
async function isPasswordReused(userId, newPassword) {
  if (!userId || !newPassword) return false;

  const pool = getPool();

  // 1. Fetch current password from users table
  const [userRows] = await pool.query(
    `SELECT password FROM users WHERE id = ? AND is_delete = 0`,
    [userId]
  );

  // 2. Fetch all historical password hashes from user_password_history table
  const [historyRows] = await pool.query(
    `SELECT password_hash FROM user_password_history WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
    [userId]
  );

  const hashesToCheck = [];

  if (userRows.length > 0 && userRows[0].password) {
    hashesToCheck.push(userRows[0].password);
  }

  for (const row of historyRows) {
    if (row.password_hash) {
      hashesToCheck.push(row.password_hash);
    }
  }

  const plainPassword = newPassword.trim();

  // 3. Compare newPassword against all active and historical hashes
  for (const hash of hashesToCheck) {
    if (hash && (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$'))) {
      const match = await bcrypt.compare(plainPassword, hash);
      if (match) return true;
    } else if (hash === plainPassword) {
      return true;
    }
  }

  return false;
}

/**
 * Save password hash into user_password_history
 */
async function recordPasswordHistory(userId, passwordHash) {
  if (!userId || !passwordHash) return;
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_password_history (user_id, password_hash) VALUES (?, ?)`,
      [userId, passwordHash]
    );
  } catch (err) {
    console.error('Error recording password history:', err);
  }
}

module.exports = {
  validatePasswordSecurity,
  isPasswordReused,
  recordPasswordHistory
};
