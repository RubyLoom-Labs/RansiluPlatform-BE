const jwt = require('jsonwebtoken');
const { getPool } = require('../config/db');
const { normalizePermissionEntry } = require('./permissionMiddleware');

const JWT_SECRET = process.env.JWT_SECRET || 'ransilu_platform_jwt_secret_key_2026';

async function authenticateToken(req, res, next) {
  let token = null;

  // 1. Check HttpOnly cookie first
  if (req.cookies && req.cookies.accessToken) {
    token = req.cookies.accessToken;
  }
  
  // 2. Fallback to Authorization header
  if (!token) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Access token is missing or required.' });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: 'Invalid or expired access token.' });
    }

    try {
      const pool = getPool();
      // Single JOIN query instead of 2 sequential ones - halves the DB connections/round
      // trips this middleware needs per request, which matters under request bursts.
      const [rows] = await pool.query(
        `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.user_role_id, u.status, u.is_delete,
                p.id as perm_id, p.tab_name, p.action, p.permission_name
         FROM users u
         LEFT JOIN role_permissions rp ON rp.role_id = u.user_role_id AND rp.is_delete = 0 AND rp.status = 1
         LEFT JOIN permissions p ON p.id = rp.permission_id AND p.is_delete = 0 AND p.status = 1
         WHERE u.id = ? AND u.is_delete = 0`,
        [decoded.id]
      );

      if (rows.length === 0 || rows[0].status === 0) {
        return res.status(403).json({ message: 'User account is inactive or deleted.' });
      }

      const { perm_id, tab_name, action, permission_name, ...user } = rows[0];
      const permissions = rows
        .filter((r) => r.perm_id !== null)
        .map((r) => normalizePermissionEntry({ id: r.perm_id, tab_name: r.tab_name, action: r.action, permission_name: r.permission_name }));

      req.user = {
        ...user,
        permissions
      };
      next();
    } catch (dbErr) {
      console.error('Auth Middleware error:', dbErr);
      res.status(500).json({ message: 'Internal server error' });
    }
  });
}

module.exports = {
  authenticateToken,
  JWT_SECRET
};
