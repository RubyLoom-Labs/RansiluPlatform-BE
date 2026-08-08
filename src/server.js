const app = require('./app');
const { initializeDatabase } = require('./config/db');
require('dotenv').config();

const PORT = process.env.PORT || 5000;

// Without these, a single unhandled error in any request handler crashes the
// whole process, dropping all other in-flight requests (seen as net::ERR_CONNECTION_RESET
// on the client) instead of failing just that one request.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

async function startServer() {
  try {
    // 1. Initialize database connection pool, tables, and seed data
    console.log('Initializing database connection...');
    await initializeDatabase();
    console.log('Database initialized successfully.');

    // 2. Start Express server listener
    const server = app.listen(PORT, () => {
      console.log(`Server is running in development mode on http://localhost:${PORT}`);
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`\n[ERROR] Port ${PORT} is already in use!`);
        console.error(`Another instance of the backend server is already running on port ${PORT}.`);
        console.error(`If you wish to restart it, stop the running process first.\n`);
      } else {
        console.error('Server error:', error.message);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('Critical failure: Could not start application server:', error.message);
    process.exit(1);
  }
}

startServer();

