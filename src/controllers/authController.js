const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getPool } = require('../config/db');
const { JWT_SECRET } = require('../middlewares/authMiddleware');
const { normalizePermissionEntry } = require('../middlewares/permissionMiddleware');
const { validatePasswordSecurity, isPasswordReused, recordPasswordHistory } = require('../utils/passwordHelper');
const { createAuditLog } = require('../utils/auditLogger');

const REFRESH_SECRET = process.env.REFRESH_SECRET || 'ransilu_platform_refresh_secret_key_2026';

// Cookie configuration helper
const COOKIE_OPTIONS_ACCESS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 15 * 60 * 1000 // 15 minutes
};

const COOKIE_OPTIONS_REFRESH = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

function getClientIp(req) {
  const forwardedFor = req.headers && req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

// Helper to create audit logs
async function createLog(userId, userOrIdentifier, action, details = null, ipAddress = null) {
  try {
    const user = userOrIdentifier && typeof userOrIdentifier === 'object'
      ? { ...userOrIdentifier, id: userOrIdentifier.id ?? userId ?? null }
      : { id: userId || null, email: userOrIdentifier || 'System', username: userOrIdentifier || 'System' };
    await createAuditLog({ user, action, details, ipAddress: ipAddress || getClientIp({ headers: {}, ip: '127.0.0.1' }) });
  } catch (err) {
    console.error('Error logging auth action:', err);
  }
}

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const pool = getPool();
    const { login, email, username, password, rememberMe } = req.body;
    const loginCredential = (login || email || username || '').trim();
    const inputPassword = (password || '').trim();

    if (!loginCredential) {
      return res.status(400).json({ message: 'Email or Username is required.' });
    }
    if (!inputPassword) {
      return res.status(400).json({ message: 'Password is required.' });
    }

    // Search user by email or username
    const [userRows] = await pool.query(
      `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.password, u.profile_image, u.user_role_id, u.status, u.is_delete,
              r.role_name
       FROM users u
       LEFT JOIN user_roles r ON u.user_role_id = r.id AND r.is_delete = 0
       WHERE (u.username = ? OR u.email = ?) AND u.is_delete = 0`,
      [loginCredential, loginCredential.toLowerCase()]
    );

    if (userRows.length === 0) {
      await createLog(null, { id: null, email: loginCredential, username: loginCredential }, 'LOGIN_FAILED', `Failed login attempt for ${loginCredential}.`, getClientIp(req));
      return res.status(401).json({ message: 'Invalid email/username or password.' });
    }

    const user = userRows[0];

    // Check account status
    if (user.status === 0) {
      await createLog(user.id, user, 'LOGIN_FAILED', 'Login attempt blocked because the account is inactive or disabled.', getClientIp(req));
      return res.status(403).json({ message: 'Your account is deactivated. Please contact an administrator.' });
    }

    // Password validation (bcrypt hash check with fallback for legacy plain text migration)
    let isPasswordValid = false;
    let needsHashUpdate = false;

    if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$'))) {
      isPasswordValid = await bcrypt.compare(inputPassword, user.password);
    } else {
      // Legacy plain-text match check
      if (user.password === inputPassword) {
        isPasswordValid = true;
        needsHashUpdate = true;
      }
    }

    if (!isPasswordValid) {
      await createLog(user.id, user, 'LOGIN_FAILED', 'Login attempt failed because the password was invalid.', getClientIp(req));
      return res.status(401).json({ message: 'Invalid email/username or password.' });
    }

    // If legacy plain-text password, migrate to bcrypt hash immediately
    if (needsHashUpdate) {
      const newHash = await bcrypt.hash(inputPassword, 10);
      await pool.query(`UPDATE users SET password = ? WHERE id = ?`, [newHash, user.id]);
    }

    // Fetch user assigned permissions
    let permissions = [];
    if (user.user_role_id) {
      const [permRows] = await pool.query(
        `SELECT p.id, p.tab_name, p.action, p.permission_name
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE rp.role_id = ? AND rp.is_delete = 0 AND rp.status = 1 AND p.is_delete = 0 AND p.status = 1`,
        [user.user_role_id]
      );
      permissions = permRows;
    }

    const tokenPayload = {
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      username: user.username,
      user_role_id: user.user_role_id,
      role_name: user.role_name || 'User'
    };

    // Generate JWT Access Token (15m) & Refresh Token (30d if rememberMe, else 7d)
    const refreshDays = rememberMe ? 30 : 7;
    const accessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user.id, username: user.username }, REFRESH_SECRET, { expiresIn: `${refreshDays}d` });

    // Single Active Session: Save new refresh token in DB, invalidating any previous session
    await pool.query(`UPDATE users SET refresh_token = ? WHERE id = ?`, [refreshToken, user.id]);

    await createLog(user.id, user, 'LOGIN_SUCCESS', `User ${user.username} logged in successfully.`, getClientIp(req));

    const refreshCookieOptions = {
      ...COOKIE_OPTIONS_REFRESH,
      maxAge: refreshDays * 24 * 60 * 60 * 1000
    };

    // Set secure HttpOnly cookies for both tokens
    res.cookie('accessToken', accessToken, COOKIE_OPTIONS_ACCESS);
    res.cookie('refreshToken', refreshToken, refreshCookieOptions);

    const userProfile = {
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      username: user.username,
      profile_image: user.profile_image || null,
      user_role_id: user.user_role_id,
      role_name: user.role_name || 'User',
      permissions
    };

    res.json({
      message: 'Login successful.',
      user: userProfile
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/auth/refresh
exports.refreshToken = async (req, res) => {
  try {
    const pool = getPool();
    const refreshToken = (req.cookies && req.cookies.refreshToken) || req.body.refreshToken;

    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required.' });
    }

    jwt.verify(refreshToken, REFRESH_SECRET, async (err, decoded) => {
      if (err) {
        res.clearCookie('accessToken', { path: '/' });
        res.clearCookie('refreshToken', { path: '/' });
        return res.status(403).json({ message: 'Invalid or expired refresh token.' });
      }

      const [userRows] = await pool.query(
        `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.profile_image, u.user_role_id, u.status, u.refresh_token,
                r.role_name
         FROM users u
         LEFT JOIN user_roles r ON u.user_role_id = r.id
         WHERE u.id = ? AND u.is_delete = 0`,
        [decoded.id]
      );

      // Verify single active session match
      if (userRows.length === 0 || userRows[0].status === 0 || userRows[0].refresh_token !== refreshToken) {
        res.clearCookie('accessToken', { path: '/' });
        res.clearCookie('refreshToken', { path: '/' });
        return res.status(403).json({ message: 'Refresh token revoked or user inactive.' });
      }

      const user = userRows[0];
      const tokenPayload = {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        username: user.username,
        user_role_id: user.user_role_id,
        role_name: user.role_name || 'User'
      };

      const newAccessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '15m' });

      // Set new Access Token HttpOnly Cookie
      res.cookie('accessToken', newAccessToken, COOKIE_OPTIONS_ACCESS);

      res.json({
        message: 'Token refreshed successfully.'
      });
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/auth/logout
exports.logout = async (req, res) => {
  try {
    const pool = getPool();
    const refreshToken = (req.cookies && req.cookies.refreshToken) || req.body.refreshToken;

    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, REFRESH_SECRET);
        await pool.query(`UPDATE users SET refresh_token = NULL WHERE id = ?`, [decoded.id]);
        await createLog(decoded.id, { id: decoded.id, email: decoded.email || decoded.username || 'User', username: decoded.username || 'User' }, 'LOGOUT_SUCCESS', 'User logged out successfully.');
      } catch (e) {
        // Token invalid, ignore DB clear step
      }
    } else if (req.user && req.user.id) {
      await pool.query(`UPDATE users SET refresh_token = NULL WHERE id = ?`, [req.user.id]);
      await createLog(req.user.id, req.user, 'LOGOUT_SUCCESS', 'User logged out successfully.');
    }

    // Clear HttpOnly authentication cookies
    res.clearCookie('accessToken', { path: '/' });
    res.clearCookie('refreshToken', { path: '/' });

    res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/auth/forgot-password
exports.forgotPassword = async (req, res) => {
  try {
    const pool = getPool();
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ message: 'Email address is required.' });
    }

    const targetEmail = email.trim().toLowerCase();

    // Check if active user exists with email
    const [userRows] = await pool.query(
      `SELECT id, firstname, lastname, username, email FROM users WHERE email = ? AND is_delete = 0 AND status = 1`,
      [targetEmail]
    );

    // Generic success response to avoid revealing whether email exists
    const genericSuccessMsg = 'If an active account exists with that email address, a password reset link has been generated.';

    if (userRows.length === 0) {
      return res.json({ message: genericSuccessMsg });
    }

    const user = userRows[0];

    // Generate secure random token & 30-minute expiry
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await pool.query(
      `UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`,
      [resetToken, expiresAt, user.id]
    );

    await createLog(user.id, user, 'FORGOT_PASSWORD_REQUEST', `Requested password reset for ${user.email}`);

    const frontendHost = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendHost}/reset-password?token=${resetToken}`;

    res.json({
      message: genericSuccessMsg,
      resetToken, // Returned for testing / demonstration UI integration
      resetLink
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/auth/reset-password
exports.resetPassword = async (req, res) => {
  try {
    const pool = getPool();
    const { token, newPassword } = req.body;

    if (!token) {
      return res.status(400).json({ message: 'Reset token is required.' });
    }
    if (!newPassword || !newPassword.trim()) {
      return res.status(400).json({ message: 'New password is required.' });
    }

    const securityCheck = validatePasswordSecurity(newPassword);
    if (!securityCheck.isValid) {
      return res.status(400).json({ message: securityCheck.message });
    }

    // Verify token & expiry in database
    const [userRows] = await pool.query(
      `SELECT id, username, email FROM users WHERE reset_token = ? AND reset_token_expires > NOW() AND is_delete = 0 AND status = 1`,
      [token]
    );

    if (userRows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired password reset token.' });
    }

    const user = userRows[0];

    // Check if password has been used before
    const reused = await isPasswordReused(user.id, newPassword);
    if (reused) {
      return res.status(400).json({ message: 'You cannot reuse a previously used password. Please enter a new password.' });
    }

    // Hash new password using bcrypt
    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

    // Update password, clear reset token & invalidate all existing sessions
    await pool.query(
      `UPDATE users SET password = ?, refresh_token = NULL, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`,
      [hashedPassword, user.id]
    );

    await recordPasswordHistory(user.id, hashedPassword);

    await createLog(user.id, user, 'RESET_PASSWORD_SUCCESS', `Password reset completed for ${user.username}`);

    res.json({
      message: 'Your password has been reset successfully. Please log in with your new password.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /api/auth/me
exports.getMe = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id;

    const [userRows] = await pool.query(
      `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.profile_image, u.user_role_id, u.status,
              r.role_name
       FROM users u
       LEFT JOIN user_roles r ON u.user_role_id = r.id
       WHERE u.id = ? AND u.is_delete = 0`,
      [userId]
    );

    if (userRows.length === 0 || userRows[0].status === 0) {
      return res.status(401).json({ message: 'User profile not found or inactive.' });
    }

    const user = userRows[0];

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

    res.json({
      user: {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        username: user.username,
        profile_image: user.profile_image || null,
        user_role_id: user.user_role_id,
        role_name: user.role_name || 'User',
        permissions
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /api/auth/profile (Update Profile)
exports.updateProfile = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id;
    const { firstname, lastname, email, profile_image } = req.body;

    if (!firstname || !firstname.trim()) {
      return res.status(400).json({ message: 'First name is required.' });
    }
    if (!lastname || !lastname.trim()) {
      return res.status(400).json({ message: 'Last name is required.' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    // Check duplicate email
    const [existing] = await pool.query(
      `SELECT id FROM users WHERE email = ? AND id != ? AND is_delete = 0`,
      [email.trim().toLowerCase(), userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Email address is already in use.' });
    }

    let imagePath = null;
    if (req.file) {
      imagePath = `/uploads/images/${req.file.filename}`;
    } else if (profile_image !== undefined && profile_image !== 'null' && profile_image !== 'undefined') {
      imagePath = profile_image ? profile_image.trim() : null;
    } else {
      const [currUser] = await pool.query(`SELECT profile_image FROM users WHERE id = ?`, [userId]);
      imagePath = currUser[0]?.profile_image || null;
    }

    await pool.query(
      `UPDATE users SET firstname = ?, lastname = ?, email = ?, profile_image = ? WHERE id = ?`,
      [firstname.trim(), lastname.trim(), email.trim().toLowerCase(), imagePath, userId]
    );

    await createLog(userId, req.user, 'UPDATE_PROFILE', `Updated profile for ${firstname} ${lastname}`);

    // Return updated user data
    const [userRows] = await pool.query(
      `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.profile_image, u.user_role_id, u.status,
              r.role_name
       FROM users u
       LEFT JOIN user_roles r ON u.user_role_id = r.id
       WHERE u.id = ?`,
      [userId]
    );

    const user = userRows[0];
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

    res.json({
      message: 'Profile updated successfully.',
      user: {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        username: user.username,
        profile_image: user.profile_image || null,
        user_role_id: user.user_role_id,
        role_name: user.role_name || 'User',
        permissions
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /api/auth/change-password
exports.changePassword = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({ message: 'Current password is required.' });
    }
    if (!newPassword || !newPassword.trim()) {
      return res.status(400).json({ message: 'New password is required.' });
    }
    if (newPassword.trim() !== (confirmPassword || '').trim()) {
      return res.status(400).json({ message: 'New passwords do not match.' });
    }

    const securityCheck = validatePasswordSecurity(newPassword);
    if (!securityCheck.isValid) {
      return res.status(400).json({ message: securityCheck.message });
    }

    // Get current stored password hash
    const [userRows] = await pool.query(`SELECT password, username FROM users WHERE id = ? AND is_delete = 0`, [userId]);
    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const user = userRows[0];
    let isCurrentValid = false;

    if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$'))) {
      isCurrentValid = await bcrypt.compare(currentPassword, user.password);
    } else {
      isCurrentValid = user.password === currentPassword;
    }

    if (!isCurrentValid) {
      return res.status(400).json({ message: 'Incorrect current password.' });
    }

    // Check if new password has been used before
    const reused = await isPasswordReused(userId, newPassword);
    if (reused) {
      return res.status(400).json({ message: 'You cannot reuse a previously used password. Please enter a new password.' });
    }

    // Hash new password using bcrypt
    const newHash = await bcrypt.hash(newPassword.trim(), 10);
    await recordPasswordHistory(userId, newHash);

    // Fetch user details & permissions for session continuation
    const [fullUserRows] = await pool.query(
      `SELECT u.id, u.firstname, u.lastname, u.email, u.username, u.profile_image, u.user_role_id, u.status,
              r.role_name
       FROM users u
       LEFT JOIN user_roles r ON u.user_role_id = r.id
       WHERE u.id = ? AND u.is_delete = 0`,
      [userId]
    );

    if (fullUserRows.length === 0) {
      return res.status(404).json({ message: 'User profile not found.' });
    }

    const userData = fullUserRows[0];
    let permissions = [];
    if (userData.user_role_id) {
      const [permRows] = await pool.query(
        `SELECT p.id, p.tab_name, p.action, p.permission_name
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE rp.role_id = ? AND rp.is_delete = 0 AND rp.status = 1 AND p.is_delete = 0 AND p.status = 1`,
        [userData.user_role_id]
      );
      permissions = permRows.map(normalizePermissionEntry);
    }

    const tokenPayload = {
      id: userData.id,
      firstname: userData.firstname,
      lastname: userData.lastname,
      email: userData.email,
      username: userData.username,
      user_role_id: userData.user_role_id,
      role_name: userData.role_name || 'User'
    };

    // Issue fresh tokens for active session
    const accessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: userData.id, username: userData.username }, REFRESH_SECRET, { expiresIn: '7d' });

    // Update password and store new refresh token in DB
    await pool.query(`UPDATE users SET password = ?, refresh_token = ? WHERE id = ?`, [newHash, refreshToken, userId]);

    await createLog(userId, userData, 'CHANGE_PASSWORD', 'Password changed successfully. Updated active session tokens.');

    // Set updated HttpOnly authentication cookies
    res.cookie('accessToken', accessToken, COOKIE_OPTIONS_ACCESS);
    res.cookie('refreshToken', refreshToken, COOKIE_OPTIONS_REFRESH);

    res.json({
      message: 'Password changed successfully.',
      user: {
        id: userData.id,
        firstname: userData.firstname,
        lastname: userData.lastname,
        email: userData.email,
        username: userData.username,
        profile_image: userData.profile_image || null,
        user_role_id: userData.user_role_id,
        role_name: userData.role_name || 'User',
        permissions
      }
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
