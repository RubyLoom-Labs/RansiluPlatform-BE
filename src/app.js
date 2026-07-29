require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const artistRoutes = require('./routes/artistRoutes');
const songRoutes = require('./routes/songRoutes');
const distributorRoutes = require('./routes/distributorRoutes');
const ringtoneRoutes = require('./routes/ringtoneRoutes');
const recordLabelRoutes = require('./routes/recordLabelRoutes');
const albumRoutes = require('./routes/albumRoutes');
const eAccountRoutes = require('./routes/eAccountRoutes');
const calendarRoutes = require('./routes/calendarRoutes');
const revenueRoutes = require('./routes/revenueRoutes');
const ownershipRoutes = require('./routes/ownershipRoutes');
const notesCasesRoutes = require('./routes/notesCasesRoutes');
const settingsRoutes = require('./routes/settings');
const authRoutes = require('./routes/auth');
const { authenticateToken } = require('./middlewares/authMiddleware');
const { requireRoutePermission } = require('./middlewares/permissionMiddleware');

const app = express();
app.set('trust proxy', true);

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://musicstation.ransilumusic.com,http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isOriginAllowed = (origin) => !origin || allowedOrigins.includes(origin);

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/artists', authenticateToken, requireRoutePermission, artistRoutes);
app.use('/api/songs', authenticateToken, requireRoutePermission, songRoutes);
app.use('/api/distributors', authenticateToken, requireRoutePermission, distributorRoutes);
app.use('/api/ringtones', authenticateToken, requireRoutePermission, ringtoneRoutes);
app.use('/api/record-label', authenticateToken, requireRoutePermission, recordLabelRoutes);
app.use('/api/recode-labels', authenticateToken, requireRoutePermission, recordLabelRoutes);
app.use('/api/albums', authenticateToken, requireRoutePermission, albumRoutes);
app.use('/api/e-accounts', authenticateToken, requireRoutePermission, eAccountRoutes);
app.use('/api/calendar/events', authenticateToken, requireRoutePermission, calendarRoutes);
app.use('/api/revenue', authenticateToken, requireRoutePermission, revenueRoutes);
app.use('/api/ownership', authenticateToken, requireRoutePermission, ownershipRoutes);
app.use('/api/ownerships', authenticateToken, requireRoutePermission, ownershipRoutes);
app.use('/api/notes-and-cases', authenticateToken, requireRoutePermission, notesCasesRoutes);
app.use('/api/notes-cases', authenticateToken, requireRoutePermission, notesCasesRoutes);
app.use('/api/settings', authenticateToken, requireRoutePermission, settingsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Ransilu Platform Backend is running.' });
});

// Error handling middleware
/* app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
  });
}); */
// Error handling middleware
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    errorDetails: err ? err.toString() : 'Unknown error', // <--- Force it to text!
    errorStack: err.stack
  });
});

module.exports = app;
