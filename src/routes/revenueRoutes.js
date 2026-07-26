const express = require('express');
const router = express.Router();
const revenueController = require('../controllers/revenueController');
const upload = require('../middlewares/upload');

router.get('/', revenueController.getRevenueData);
router.get('/template-export', revenueController.exportRevenueTemplate);
router.get('/export', revenueController.exportRevenueData);
router.post('/import', upload.single('file'), revenueController.importRevenueData);

module.exports = router;
