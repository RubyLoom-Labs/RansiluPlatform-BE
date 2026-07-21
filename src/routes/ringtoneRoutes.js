const express = require('express');
const router = express.Router();
const ringtoneController = require('../controllers/ringtoneController');
const upload = require('../middlewares/upload');

router.get('/', ringtoneController.getRingtones);
router.post('/', upload.single('logo'), ringtoneController.createRingtone);

// Specific sub-routes BEFORE generic /:id to avoid conflicts
router.put('/:id/inactivate', ringtoneController.inactivateRingtone);
router.put('/:id/activate', ringtoneController.activateRingtone);
router.get('/:id/songs', ringtoneController.getRingtoneSongs);

router.get('/:id', ringtoneController.getRingtoneById);
router.put('/:id', upload.single('logo'), ringtoneController.updateRingtone);
router.delete('/:id', ringtoneController.deleteRingtone);

module.exports = router;
