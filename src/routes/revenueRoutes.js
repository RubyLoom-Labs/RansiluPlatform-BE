const express = require('express');
const router = express.Router();
const revenueController = require('../controllers/revenueController');
const upload = require('../middlewares/upload');

router.get('/', revenueController.getRevenueData);
router.get('/template-export', revenueController.exportRevenueTemplate);
router.get('/export', revenueController.exportRevenueData);
router.get('/song/:id', revenueController.getSongRevenueDetails);
router.get('/artist/:id/songs', revenueController.getArtistSongs);
router.get('/artist/:id', revenueController.getArtistRevenueDetails);
router.post('/artist/:id/mark-paid', revenueController.markArtistAsPaid);
router.post('/import', upload.single('file'), revenueController.importRevenueData);
router.put('/:id', revenueController.updateRevenueRecord);
router.delete('/:id', revenueController.deleteRevenueRecord);

module.exports = router;
