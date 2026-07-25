const { getPool } = require('../config/db');

async function up(passedPool) {
  const pool = passedPool || getPool();

  console.log('Running migration 024: Create Settings Tables (user_roles, permissions, role_permissions, users, user_logs)...');

  // 1. Create user_roles table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role_name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      status TINYINT DEFAULT 1 COMMENT '1=Active, 0=Inactive',
      is_delete TINYINT DEFAULT 0 COMMENT '0=Active, 1=Deleted',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 2. Create permissions table (per tab + CRUD operation)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tab_name VARCHAR(100) NOT NULL,
      action VARCHAR(50) NOT NULL COMMENT 'create, read, update, delete',
      permission_name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      status TINYINT DEFAULT 1,
      is_delete TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_tab_action (tab_name, action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 3. Create role_permissions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role_id INT NOT NULL,
      permission_id INT NOT NULL,
      status TINYINT DEFAULT 1,
      is_delete TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES user_roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
      UNIQUE KEY unique_role_perm (role_id, permission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 4. Create users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      firstname VARCHAR(100) NOT NULL,
      lastname VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      username VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NULL,
      user_role_id INT NULL,
      status TINYINT DEFAULT 1 COMMENT '1=Active, 0=Inactive',
      is_delete TINYINT DEFAULT 0 COMMENT '0=Active, 1=Deleted',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_role_id) REFERENCES user_roles(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 5. Create user_logs table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      action VARCHAR(255) NOT NULL,
      details TEXT NULL,
      ip_address VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Seed default roles if empty
  const [existingRoles] = await pool.query(`SELECT COUNT(*) as count FROM user_roles`);
  if (existingRoles[0].count === 0) {
    await pool.query(`
      INSERT INTO user_roles (role_name, description, status, is_delete) VALUES
      ('Super Admin', 'Full system access and permission control', 1, 0),
      ('Manager', 'Management level access to core modules', 1, 0),
      ('Editor', 'Can create and edit records in system modules', 1, 0),
      ('Viewer', 'Read only view access across modules', 1, 0)
    `);
    console.log('Seeded default user roles.');
  }

  // Seed permissions for each tab module if empty
  const systemTabs = [
    'Songs', 'Albums', 'Artists', 'Distributor', 'E-Accounts',
    'Notes & Cases', 'Calendar', 'Ringtone', 'Ownership',
    'Recode Labels', 'Revenue', 'Settings'
  ];
  const actions = ['create', 'read', 'update', 'delete'];

  for (const tab of systemTabs) {
    for (const act of actions) {
      await pool.query(
        `INSERT IGNORE INTO permissions (tab_name, action, permission_name, description, status, is_delete)
         VALUES (?, ?, ?, ?, 1, 0)`,
        [tab, act, `${tab} - ${act.toUpperCase()}`, `Permission to ${act} in ${tab}`]
      );
    }
  }

  // Seed Super Admin role all permissions
  const [adminRole] = await pool.query(`SELECT id FROM user_roles WHERE role_name = 'Super Admin' LIMIT 1`);
  if (adminRole.length > 0) {
    const adminRoleId = adminRole[0].id;
    const [allPerms] = await pool.query(`SELECT id FROM permissions`);
    for (const perm of allPerms) {
      await pool.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id, status, is_delete) VALUES (?, ?, 1, 0)`,
        [adminRoleId, perm.id]
      );
    }
  }

  // Seed initial Admin user if empty
  const [existingUsers] = await pool.query(`SELECT COUNT(*) as count FROM users`);
  if (existingUsers[0].count === 0 && adminRole.length > 0) {
    await pool.query(`
      INSERT INTO users (firstname, lastname, email, username, password, user_role_id, status, is_delete)
      VALUES ('System', 'Admin', 'admin@ransilu.com', 'admin', 'admin123', ?, 1, 0)
    `, [adminRole[0].id]);
    console.log('Seeded default admin user.');
  }

  console.log('Migration 024 completed successfully.');
}

async function down(passedPool) {
  const pool = passedPool || getPool();
  await pool.query(`DROP TABLE IF EXISTS user_logs`);
  await pool.query(`DROP TABLE IF EXISTS users`);
  await pool.query(`DROP TABLE IF EXISTS role_permissions`);
  await pool.query(`DROP TABLE IF EXISTS permissions`);
  await pool.query(`DROP TABLE IF EXISTS user_roles`);
}

module.exports = { up, down };
