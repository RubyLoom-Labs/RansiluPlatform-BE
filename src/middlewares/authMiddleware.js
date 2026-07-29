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
      const [rows] = await pool.query(
        `SELECT id, firstname, lastname, email, username, user_role_id, status, is_delete FROM users WHERE id = ? AND is_delete = 0`,
        [decoded.id]
      );

      if (rows.length === 0 || rows[0].status === 0) {
        return res.status(403).json({ message: 'User account is inactive or deleted.' });
      }

      const user = rows[0];
      let permissions = [];

      if (user.user_role_id) {
        const [permRows] = await pool.query(
          `SELECT p.id, p.tab_name, p.action, p.permission_name
           FROM role_permissions rp
           JOIN permissions p ON rp.permission_id = p.id
           WHERE rp.role_id = ? AND rp.is_delete = 0 AND rp.status = 1 AND p.is_delete = 0 AND p.status = 1`,
          [user.user_role_id]
        );
        permissions = permRows.map(normalizePermissionEntry);
      }

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
