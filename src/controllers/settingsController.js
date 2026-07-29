const bcrypt = require('bcryptjs');
const { getPool } = require('../config/db');
const { normalizePermissionEntry } = require('../middlewares/permissionMiddleware');
const { validatePasswordSecurity, isPasswordReused, recordPasswordHistory } = require('../utils/passwordHelper');
const { createAuditLog } = require('../utils/auditLogger');

async function createLog(userId, userOrIdentifier, action, details = null, ipAddress = null) {
  try {
    const user = userOrIdentifier && typeof userOrIdentifier === 'object'
      ? { ...userOrIdentifier, id: userOrIdentifier.id ?? userId ?? null }
      : { id: userId || null, email: userOrIdentifier || 'System', username: userOrIdentifier || 'System' };
    await createAuditLog({ user, action, details, ipAddress });
  } catch (err) {
    console.error('Error logging settings action:', err);
  }
}

// -------------------------------------------------------------
// 1. USERS ENDPOINTS
// -------------------------------------------------------------

// GET /api/settings/users
exports.getUsers = async (req, res) => {
  try {
    const pool = getPool();
    const { search, status, role_id } = req.query;

    let query = `
      SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.user_role_id, u.status, u.is_delete, u.created_at, u.updated_at,
             r.role_name
      FROM users u
      LEFT JOIN user_roles r ON u.user_role_id = r.id AND r.is_delete = 0
      WHERE u.is_delete = 0
    `;
    const queryParams = [];

    if (search && search.trim()) {
      query += ` AND (u.firstname LIKE ? OR u.lastname LIKE ? OR u.email LIKE ? OR u.username LIKE ?)`;
      const s = `%${search.trim()}%`;
      queryParams.push(s, s, s, s);
    }

    if (status !== undefined && status !== '') {
      query += ` AND u.status = ?`;
      queryParams.push(parseInt(status, 10));
    }

    if (role_id) {
      query += ` AND u.user_role_id = ?`;
      queryParams.push(parseInt(role_id, 10));
    }

    query += ` ORDER BY u.id DESC`;

    const [rows] = await pool.query(query, queryParams);

    res.json({
      users: rows,
      totalCount: rows.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/settings/users (Create new user: status automatically 1, is_delete = 0)
exports.createUser = async (req, res) => {
  try {
    const pool = getPool();
    const { firstname, lastname, email, username, password, user_role_id } = req.body;

    if (!firstname || !firstname.trim()) {
      return res.status(400).json({ message: 'First name is required.' });
    }
    if (!lastname || !lastname.trim()) {
      return res.status(400).json({ message: 'Last name is required.' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ message: 'Email is required.' });
    }
    if (!username || !username.trim()) {
      return res.status(400).json({ message: 'Username is required.' });
    }

    const plainPassword = password ? password.trim() : 'Password123!';
    const securityCheck = validatePasswordSecurity(plainPassword);
    if (!securityCheck.isValid) {
      return res.status(400).json({ message: securityCheck.message });
    }

    // Check duplicate username or email
    const [existing] = await pool.query(
      `SELECT id FROM users WHERE (username = ? OR email = ?) AND is_delete = 0`,
      [username.trim(), email.trim()]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Username or Email is already in use.' });
    }

    const roleId = user_role_id ? parseInt(user_role_id, 10) : null;
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const [result] = await pool.query(
      `INSERT INTO users (firstname, lastname, email, username, password, user_role_id, status, is_delete)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
      [
        firstname.trim(),
        lastname.trim(),
        email.trim().toLowerCase(),
        username.trim(),
        hashedPassword,
        roleId
      ]
    );

    const newUserId = result.insertId;
    await recordPasswordHistory(newUserId, hashedPassword);

    await createLog(newUserId, req.user || { id: null, email: email.trim(), username: username.trim() }, 'CREATE_USER', `Created user ${firstname} ${lastname}`);

    const [userRows] = await pool.query(
      `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.user_role_id, u.status, u.is_delete, u.created_at,
              r.role_name
       FROM users u
       LEFT JOIN user_roles r ON u.user_role_id = r.id
       WHERE u.id = ?`,
      [newUserId]
    );

    res.status(201).json({
      message: 'User created successfully.',
      user: userRows[0]
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /api/settings/users/:id
exports.updateUser = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid User ID' });
    }

    const { firstname, lastname, email, username, password, user_role_id, status } = req.body;

    if (!firstname || !firstname.trim()) {
      return res.status(400).json({ message: 'First name is required.' });
    }
    if (!lastname || !lastname.trim()) {
      return res.status(400).json({ message: 'Last name is required.' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ message: 'Email is required.' });
    }
    if (!username || !username.trim()) {
      return res.status(400).json({ message: 'Username is required.' });
    }

    // Check duplicate
    const [existing] = await pool.query(
      `SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ? AND is_delete = 0`,
      [username.trim(), email.trim(), id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Username or Email is already used by another account.' });
    }

    const roleId = user_role_id ? parseInt(user_role_id, 10) : null;
    const userStatus = status !== undefined ? parseInt(status, 10) : 1;

    let updateQuery = `
      UPDATE users SET
        firstname = ?,
        lastname = ?,
        email = ?,
        username = ?,
        user_role_id = ?,
        status = ?
    `;
    const updateParams = [firstname.trim(), lastname.trim(), email.trim().toLowerCase(), username.trim(), roleId, userStatus];

    if (password && password.trim()) {
      const securityCheck = validatePasswordSecurity(password);
      if (!securityCheck.isValid) {
        return res.status(400).json({ message: securityCheck.message });
      }

      const reused = await isPasswordReused(id, password);
      if (reused) {
        return res.status(400).json({ message: 'You cannot reuse a previously used password. Please choose a new password.' });
      }

      const hashedPassword = await bcrypt.hash(password.trim(), 10);
      await recordPasswordHistory(id, hashedPassword);
      updateQuery += `, password = ?`;
      updateParams.push(hashedPassword);
    }

    updateQuery += ` WHERE id = ? AND is_delete = 0`;
    updateParams.push(id);

    await pool.query(updateQuery, updateParams);

    await createLog(id, req.user || { id: null, email: email.trim(), username: username.trim() }, 'UPDATE_USER', `Updated user ${firstname} ${lastname}`);

    const [userRows] = await pool.query(
      `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.user_role_id, u.status, u.is_delete, u.created_at,
              r.role_name
       FROM users u
       LEFT JOIN user_roles r ON u.user_role_id = r.id
       WHERE u.id = ?`,
      [id]
    );

    res.json({
      message: 'User updated successfully.',
      user: userRows[0]
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /api/settings/users/:id (Soft delete: set is_delete = 1)
exports.deleteUser = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid User ID' });
    }

    const [existing] = await pool.query(`SELECT username FROM users WHERE id = ?`, [id]);
    const username = existing[0]?.username || 'User';

    await pool.query(`UPDATE users SET is_delete = 1 WHERE id = ?`, [id]);

    await createLog(id, req.user || { id: null, email: email || username, username: username || email }, 'DELETE_USER', `Soft deleted user ID ${id} (${username})`);

    res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// -------------------------------------------------------------
// 2. USER ROLES & PERMISSIONS ENDPOINTS
// -------------------------------------------------------------

// GET /api/settings/roles (List roles where status = 1 and is_delete = 0, plus user count)
exports.getRoles = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(`
      SELECT r.id, r.role_name, r.description, r.status, r.is_delete, r.created_at, r.updated_at,
             COUNT(u.id) as user_count
      FROM user_roles r
      LEFT JOIN users u ON r.id = u.user_role_id AND u.is_delete = 0
      WHERE r.is_delete = 0 AND r.status = 1
      GROUP BY r.id
      ORDER BY r.id ASC
    `);

    res.json({
      roles: rows,
      totalCount: rows.length
    });
  } catch (error) {
    console.error('Error fetching user roles:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /api/settings/roles/:id (Get role details and its assigned permission IDs)
exports.getRoleById = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid Role ID' });
    }

    const [roleRows] = await pool.query(
      `SELECT id, role_name, description, status, is_delete, created_at FROM user_roles WHERE id = ? AND is_delete = 0`,
      [id]
    );

    if (roleRows.length === 0) {
      return res.status(404).json({ message: 'Role not found' });
    }

    const [permRows] = await pool.query(
      `SELECT permission_id FROM role_permissions WHERE role_id = ? AND is_delete = 0 AND status = 1`,
      [id]
    );

    const permissionIds = permRows.map(p => p.permission_id);

    res.json({
      role: roleRows[0],
      permissionIds
    });
  } catch (error) {
    console.error('Error fetching role details:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/settings/roles (Create role and assign checked permissions)
exports.createRole = async (req, res) => {
  try {
    const pool = getPool();
    const { role_name, description, permission_ids } = req.body;

    if (!role_name || !role_name.trim()) {
      return res.status(400).json({ message: 'Role Name is required.' });
    }

    const [existing] = await pool.query(
      `SELECT id FROM user_roles WHERE role_name = ? AND is_delete = 0`,
      [role_name.trim()]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: 'A role with this name already exists.' });
    }

    const [result] = await pool.query(
      `INSERT INTO user_roles (role_name, description, status, is_delete)
       VALUES (?, ?, 1, 0)`,
      [role_name.trim(), description ? description.trim() : null]
    );

    const newRoleId = result.insertId;

    if (Array.isArray(permission_ids) && permission_ids.length > 0) {
      for (const pId of permission_ids) {
        await pool.query(
          `INSERT IGNORE INTO role_permissions (role_id, permission_id, status, is_delete) VALUES (?, ?, 1, 0)`,
          [newRoleId, pId]
        );
      }
    }

    await createLog(null, req.user || { id: null, email: 'Admin', username: 'Admin' }, 'CREATE_ROLE', `Created role ${role_name.trim()}`);

    res.status(201).json({
      message: 'User Role created successfully.',
      role: {
        id: newRoleId,
        role_name: role_name.trim(),
        description: description ? description.trim() : null,
        status: 1,
        is_delete: 0
      }
    });
  } catch (error) {
    console.error('Error creating role:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /api/settings/roles/:id (Update role name and permissions)
exports.updateRole = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid Role ID' });
    }

    const { role_name, description, permission_ids, status } = req.body;

    if (!role_name || !role_name.trim()) {
      return res.status(400).json({ message: 'Role Name is required.' });
    }

    const [existing] = await pool.query(
      `SELECT id FROM user_roles WHERE role_name = ? AND id != ? AND is_delete = 0`,
      [role_name.trim(), id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: 'A role with this name already exists.' });
    }

    const roleStatus = status !== undefined ? parseInt(status, 10) : 1;

    await pool.query(
      `UPDATE user_roles SET role_name = ?, description = ?, status = ? WHERE id = ? AND is_delete = 0`,
      [role_name.trim(), description ? description.trim() : null, roleStatus, id]
    );

    // Delete existing permissions mapping for role and insert new set
    await pool.query(`DELETE FROM role_permissions WHERE role_id = ?`, [id]);

    if (Array.isArray(permission_ids) && permission_ids.length > 0) {
      for (const pId of permission_ids) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, status, is_delete) VALUES (?, ?, 1, 0)`,
          [id, pId]
        );
      }
    }

    await createLog(null, req.user || { id: null, email: 'Admin', username: 'Admin' }, 'UPDATE_ROLE', `Updated role ${role_name.trim()}`);

    res.json({
      message: 'User Role updated successfully.'
    });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /api/settings/roles/:id (Soft delete role: set is_delete = 1)
exports.deleteRole = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid Role ID' });
    }

    await pool.query(`UPDATE user_roles SET is_delete = 1 WHERE id = ?`, [id]);
    await createLog(null, req.user || { id: null, email: 'Admin', username: 'Admin' }, 'DELETE_ROLE', `Soft deleted role ID ${id}`);

    res.json({ message: 'User Role deleted successfully.' });
  } catch (error) {
    console.error('Error deleting role:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// -------------------------------------------------------------
// 3. PERMISSIONS ENDPOINT
// -------------------------------------------------------------

// GET /api/settings/permissions
exports.getPermissions = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, tab_name, action, permission_name, description FROM permissions WHERE is_delete = 0 AND status = 1 ORDER BY id ASC`
    );

    res.json({
      permissions: rows.map(normalizePermissionEntry)
    });
  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// -------------------------------------------------------------
// 4. USER LOGS ENDPOINT
// -------------------------------------------------------------

// GET /api/settings/logs
exports.getLogs = async (req, res) => {
  try {
    const pool = getPool();
    const { search } = req.query;

    let query = `SELECT id, user_id, username, action, details, ip_address, created_at FROM user_logs`;
    const queryParams = [];

    if (search && search.trim()) {
      query += ` WHERE username LIKE ? OR action LIKE ? OR details LIKE ?`;
      const s = `%${search.trim()}%`;
      queryParams.push(s, s, s);
    }

    query += ` ORDER BY created_at DESC LIMIT 200`;

    const [rows] = await pool.query(query, queryParams);

    res.json({
      logs: rows,
      totalCount: rows.length
    });
  } catch (error) {
    console.error('Error fetching user logs:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
