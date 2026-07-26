const { getPool } = require('../config/db');

async function up(passedPool) {
  const pool = passedPool || getPool();

  console.log('Running migration 027: Create user_password_history table...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_password_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('Migration 027 completed successfully.');
}

async function down(passedPool) {
  const pool = passedPool || getPool();
  await pool.query(`DROP TABLE IF EXISTS user_password_history`);
}

module.exports = { up, down };
