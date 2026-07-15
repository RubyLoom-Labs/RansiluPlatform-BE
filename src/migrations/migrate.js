const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};

async function runMigrations(customPool = null) {
  const dbName = process.env.DB_NAME || 'ransilu_db';
  let connection;

  let pool = customPool;

  if (!pool) {
    try {
      // 1. Connect without db to create database if not exists
      connection = await mysql.createConnection(dbConfig);
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
      );
      console.log(`Database '${dbName}' verified/created.`);
    } catch (error) {
      console.error('Migration Runner - Database creation failed:', error.message);
      if (require.main === module) process.exit(1);
      throw error;
    } finally {
      if (connection) await connection.end();
    }

    // 2. Connect with database target
    pool = mysql.createPool({
      ...dbConfig,
      database: dbName,
    });
  }

  try {
    // 3. Create migrations tracker table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    // 4. Read migration files in src/migrations
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.js') && file !== 'migrate.js')
      .sort();

    console.log(`Discovered ${files.length} migration files.`);

    // 5. Run each pending migration
    for (const file of files) {
      const [rows] = await pool.query('SELECT * FROM migrations WHERE name = ?', [file]);
      if (rows.length === 0) {
        console.log(`Running migration: ${file}...`);
        const migration = require(path.join(migrationsDir, file));
        
        // Execute the migration's up function
        await migration.up(pool);
        
        // Record as executed
        await pool.query('INSERT INTO migrations (name) VALUES (?)', [file]);
        console.log(`Migration ${file} completed successfully.`);
      } else {
        console.log(`Migration ${file} has already been executed. Skipping.`);
      }
    }

    console.log('All migrations completed successfully.');
  } catch (error) {
    console.error('Migration execution failed:', error);
    if (require.main === module) process.exit(1);
    throw error;
  } finally {
    if (!customPool) {
      await pool.end();
    }
  }
}

// Support running directly from command line
if (require.main === module) {
  runMigrations();
}

module.exports = runMigrations;
