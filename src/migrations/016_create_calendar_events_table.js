const { getPool } = require('../config/db');

async function up() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_event (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_name VARCHAR(255) NOT NULL,
      description TEXT,
      event_date DATE NOT NULL,
      event_time VARCHAR(50) NOT NULL,
      is_delete TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

module.exports = { up };
