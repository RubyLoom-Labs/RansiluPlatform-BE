const { getPool } = require('../config/db');

// Helper to count words in string
function countWords(str) {
  if (!str || typeof str !== 'string') return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// Helper to check for duplicate active (is_delete = 0) accounts
async function checkDuplicateAccount(pool, normType, data, excludeId = null) {
  let baseQuery = 'SELECT id FROM e_accounts WHERE account_type = ? AND (is_delete = 0 OR is_delete IS NULL)';
  let queryParams = [normType];

  if (excludeId) {
    baseQuery += ' AND id != ?';
    queryParams.push(excludeId);
  }

  if (normType === 'email' && data.email_name) {
    const query = baseQuery + ' AND LOWER(TRIM(email_name)) = LOWER(TRIM(?))';
    const [rows] = await pool.query(query, [...queryParams, data.email_name]);
    if (rows.length > 0) {
      return 'An Email Account with this Email Name already exists.';
    }
  } else if (normType === 'domain' && data.name) {
    const query = baseQuery + ' AND LOWER(TRIM(name)) = LOWER(TRIM(?))';
    const [rows] = await pool.query(query, [...queryParams, data.name]);
    if (rows.length > 0) {
      return 'A Domain with this Domain Name already exists.';
    }
  } else if (normType === 'server' && data.name) {
    const query = baseQuery + ' AND LOWER(TRIM(name)) = LOWER(TRIM(?))';
    const [rows] = await pool.query(query, [...queryParams, data.name]);
    if (rows.length > 0) {
      return 'A Server with this Server Name already exists.';
    }
  } else if (normType === 'social_account' && data.social_type && data.mail) {
    const query = baseQuery + ' AND LOWER(TRIM(social_type)) = LOWER(TRIM(?)) AND LOWER(TRIM(mail)) = LOWER(TRIM(?))';
    const [rows] = await pool.query(query, [...queryParams, data.social_type, data.mail]);
    if (rows.length > 0) {
      return `A Social Account (${data.social_type}) with this Mail already exists.`;
    }
  } else if (normType === 'subscription' && data.subscription_for && data.name) {
    const query = baseQuery + ' AND LOWER(TRIM(subscription_for)) = LOWER(TRIM(?)) AND LOWER(TRIM(name)) = LOWER(TRIM(?))';
    const [rows] = await pool.query(query, [...queryParams, data.subscription_for, data.name]);
    if (rows.length > 0) {
      return 'A Subscription for this item with this Name already exists.';
    }
  }

  return null;
}

// GET /api/e-accounts (Get all e-accounts with optional filtering)
exports.getEAccounts = async (req, res) => {
  try {
    const pool = getPool();
    const type = req.query.type || req.query.account_type || '';
    const search = req.query.search || '';

    let whereClauses = ['(is_delete = 0 OR is_delete IS NULL)'];
    let queryParams = [];

    if (type) {
      // Handle mapping from FE tab keys (emails, domains, servers, socialAccount, subscriptions)
      let dbType = type;
      if (type === 'emails') dbType = 'email';
      else if (type === 'domains') dbType = 'domain';
      else if (type === 'servers') dbType = 'server';
      else if (type === 'socialAccount' || type === 'social-account') dbType = 'social_account';
      else if (type === 'subscriptions') dbType = 'subscription';

      whereClauses.push('account_type = ?');
      queryParams.push(dbType);
    }

    if (search) {
      whereClauses.push('(email_name LIKE ? OR name LIKE ? OR account_email LIKE ? OR mail LIKE ? OR who_has LIKE ? OR description LIKE ?)');
      const q = `%${search}%`;
      queryParams.push(q, q, q, q, q, q);
    }

    const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const [rows] = await pool.query(`SELECT * FROM e_accounts ${whereStr} ORDER BY id DESC`, queryParams);

    res.json({
      accounts: rows,
      totalCount: rows.length
    });
  } catch (error) {
    console.error('Error fetching e-accounts:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /api/e-accounts (Create new e-account)
exports.createEAccount = async (req, res) => {
  try {
    const pool = getPool();
    const {
      account_type,
      type,
      email_name,
      recovery_phone,
      recovery_email,
      name,
      why_buy,
      account_email,
      social_type,
      subscription_for,
      mail,
      renew_date,
      description,
      who_has
    } = req.body;

    const rawType = account_type || type;
    if (!rawType) {
      return res.status(400).json({ message: 'Account Type is required.' });
    }

    // Normalize type string
    let normType = rawType.toLowerCase();
    if (normType === 'emails') normType = 'email';
    if (normType === 'domains') normType = 'domain';
    if (normType === 'servers') normType = 'server';
    if (normType === 'socialaccount' || normType === 'social-account' || normType === 'social_account') normType = 'social_account';
    if (normType === 'subscriptions') normType = 'subscription';

    // Word count check for description
    if (description && countWords(description) > 350) {
      return res.status(400).json({ message: 'Description cannot exceed 350 words.' });
    }

    // Field validations per type
    if (normType === 'email') {
      if (!email_name) return res.status(400).json({ message: 'Email Name is required.' });
      if (!recovery_phone) return res.status(400).json({ message: 'Recovery Phone Number is required.' });
      if (!recovery_email) return res.status(400).json({ message: 'Recovery Email is required.' });
      if (!description) return res.status(400).json({ message: 'Description is required.' });
      if (!who_has) return res.status(400).json({ message: 'Who Has is required.' });
    } else if (normType === 'domain' || normType === 'server') {
      if (!name) return res.status(400).json({ message: `${normType === 'domain' ? 'Domain' : 'Server'} Name is required.` });
      if (!why_buy) return res.status(400).json({ message: 'Why was buy is required.' });
      if (!account_email) return res.status(400).json({ message: 'Account Email is required.' });
      if (!renew_date) return res.status(400).json({ message: 'Renew Date is required.' });
      if (!description) return res.status(400).json({ message: 'Description is required.' });
      if (!who_has) return res.status(400).json({ message: 'Who Has is required.' });
    } else if (normType === 'social_account') {
      if (!social_type) return res.status(400).json({ message: 'Social Account Type is required.' });
      if (!name) return res.status(400).json({ message: 'Name is required.' });
      if (!mail) return res.status(400).json({ message: 'Mail is required.' });
      if (!description) return res.status(400).json({ message: 'Description is required.' });
      if (!who_has) return res.status(400).json({ message: 'Who Has is required.' });
    } else if (normType === 'subscription') {
      if (!subscription_for) return res.status(400).json({ message: 'Subscription For is required.' });
      if (!name) return res.status(400).json({ message: 'Name is required.' });
      if (!mail) return res.status(400).json({ message: 'Mail is required.' });
      if (!description) return res.status(400).json({ message: 'Description is required.' });
      if (!renew_date) return res.status(400).json({ message: 'Renew Date is required.' });
      if (!who_has) return res.status(400).json({ message: 'Who Has is required.' });
    }

    // Check for duplicate active record
    const dupMessage = await checkDuplicateAccount(pool, normType, req.body);
    if (dupMessage) {
      return res.status(400).json({ message: dupMessage });
    }

    const [result] = await pool.query(
      `INSERT INTO e_accounts (
        account_type, email_name, recovery_phone, recovery_email, name, why_buy,
        account_email, social_type, subscription_for, mail, renew_date, description, who_has
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normType,
        email_name || null,
        recovery_phone || null,
        recovery_email || null,
        name || null,
        why_buy || null,
        account_email || null,
        social_type || null,
        subscription_for || null,
        mail || null,
        renew_date || null,
        description || null,
        who_has || null
      ]
    );

    const [newRows] = await pool.query('SELECT * FROM e_accounts WHERE id = ?', [result.insertId]);

    res.status(201).json({
      message: 'E-Account created successfully',
      account: newRows[0]
    });
  } catch (error) {
    console.error('Error creating e-account:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// DELETE /api/e-accounts/:id (Soft delete e-account)
exports.deleteEAccount = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    await pool.query('UPDATE e_accounts SET is_delete = 1 WHERE id = ?', [id]);
    res.json({ message: 'E-Account deleted successfully' });
  } catch (error) {
    console.error('Error deleting e-account:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /api/e-accounts/:id (Update e-account)
exports.updateEAccount = async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const {
      account_type,
      type,
      email_name,
      recovery_phone,
      recovery_email,
      name,
      why_buy,
      account_email,
      social_type,
      subscription_for,
      mail,
      renew_date,
      description,
      who_has
    } = req.body;

    const rawType = account_type || type;
    if (!rawType) {
      return res.status(400).json({ message: 'Account Type is required.' });
    }

    let normType = rawType.toLowerCase();
    if (normType === 'emails') normType = 'email';
    if (normType === 'domains') normType = 'domain';
    if (normType === 'servers') normType = 'server';
    if (normType === 'socialaccount' || normType === 'social-account' || normType === 'social_account') normType = 'social_account';
    if (normType === 'subscriptions') normType = 'subscription';

    if (description && countWords(description) > 350) {
      return res.status(400).json({ message: 'Description cannot exceed 350 words.' });
    }

    // Check for duplicate active record excluding current ID
    const dupMessage = await checkDuplicateAccount(pool, normType, req.body, id);
    if (dupMessage) {
      return res.status(400).json({ message: dupMessage });
    }

    await pool.query(
      `UPDATE e_accounts SET
        account_type = ?,
        email_name = ?,
        recovery_phone = ?,
        recovery_email = ?,
        name = ?,
        why_buy = ?,
        account_email = ?,
        social_type = ?,
        subscription_for = ?,
        mail = ?,
        renew_date = ?,
        description = ?,
        who_has = ?
      WHERE id = ? AND (is_delete = 0 OR is_delete IS NULL)`,
      [
        normType,
        email_name || null,
        recovery_phone || null,
        recovery_email || null,
        name || null,
        why_buy || null,
        account_email || null,
        social_type || null,
        subscription_for || null,
        mail || null,
        renew_date || null,
        description || null,
        who_has || null,
        id
      ]
    );

    const [updatedRows] = await pool.query('SELECT * FROM e_accounts WHERE id = ?', [id]);
    if (updatedRows.length === 0) {
      return res.status(404).json({ message: 'E-Account not found.' });
    }

    res.json({
      message: 'E-Account updated successfully',
      account: updatedRows[0]
    });
  } catch (error) {
    console.error('Error updating e-account:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
