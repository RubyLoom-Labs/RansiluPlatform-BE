const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/upload');

// Public authentication routes
router.post('/login', authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/logout', authController.logout);

// Protected auth profile routes
router.get('/me', authenticateToken, authController.getMe);
router.put('/profile', authenticateToken, upload.single('profile_image'), authController.updateProfile);
router.put('/change-password', authenticateToken, authController.changePassword);

module.exports = router;
