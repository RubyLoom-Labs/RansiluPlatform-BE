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

const app = express();

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl) or echo requesting origin
    callback(null, origin || true);
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
app.use('/api/artists', artistRoutes);
app.use('/api/songs', songRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/ringtones', ringtoneRoutes);
app.use('/api/record-label', recordLabelRoutes);
app.use('/api/recode-labels', recordLabelRoutes);
app.use('/api/albums', albumRoutes);
app.use('/api/e-accounts', eAccountRoutes);
app.use('/api/calendar/events', calendarRoutes);
app.use('/api/revenue', revenueRoutes);
app.use('/api/ownership', ownershipRoutes);
app.use('/api/ownerships', ownershipRoutes);
app.use('/api/notes-and-cases', notesCasesRoutes);
app.use('/api/notes-cases', notesCasesRoutes);
app.use('/api/settings', settingsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Ransilu Platform Backend is running.' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
  });
});

module.exports = app;
