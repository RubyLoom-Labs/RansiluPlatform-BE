const { getPool } = require('../config/db');

async function up() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS e_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_type VARCHAR(50) NOT NULL,
      email_name VARCHAR(255),
      recovery_phone VARCHAR(100),
      recovery_email VARCHAR(255),
      name VARCHAR(255),
      why_buy VARCHAR(255),
      account_email VARCHAR(255),
      social_type VARCHAR(100),
      subscription_for VARCHAR(255),
      mail VARCHAR(255),
      renew_date DATE,
      description TEXT,
      who_has VARCHAR(255),
      status TINYINT DEFAULT 1,
      is_delete TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

module.exports = { up };
