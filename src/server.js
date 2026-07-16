const app = require('./app');
const { initializeDatabase } = require('./config/db');
require('dotenv').config();
// Trigger restart 2

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // 1. Initialize database connection pool, tables, and seed data
    console.log('Initializing database connection...');
    await initializeDatabase();
    console.log('Database initialized successfully.');

    // 2. Start Express server listener
    app.listen(PORT, () => {
      console.log(`Server is running in development mode on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Critical failure: Could not start application server:', error.message);
    process.exit(1);
  }
}

startServer();
