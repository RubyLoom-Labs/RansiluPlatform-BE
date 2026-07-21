const express = require('express');
const router = express.Router();
const recordLabelController = require('../controllers/recordLabelController');

router.get('/', recordLabelController.getRecordLabels);
router.get('/search', recordLabelController.searchRecordLabels);
router.get('/export', recordLabelController.exportRecordLabels);
router.post('/', recordLabelController.createRecordLabel);

// Specific sub-routes BEFORE generic /:id to avoid route conflicts
router.get('/:id/songs', recordLabelController.getRecordLabelSongs);
router.get('/:id/details', recordLabelController.getRecordLabelById);
router.put('/:id/inactivate', recordLabelController.inactivateRecordLabel);
router.put('/:id/activate', recordLabelController.activateRecordLabel);
router.patch('/:id/reactivate', recordLabelController.activateRecordLabel);
router.patch('/:id/status', recordLabelController.inactivateRecordLabel);

router.get('/:id', recordLabelController.getRecordLabelById);
router.put('/:id', recordLabelController.updateRecordLabel);
router.delete('/:id', recordLabelController.deleteRecordLabel);

module.exports = router;
