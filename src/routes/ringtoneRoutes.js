const express = require('express');
const router = express.Router();
const ringtoneController = require('../controllers/ringtoneController');
const upload = require('../middlewares/upload');

router.get('/', ringtoneController.getRingtones);
router.get('/:id', ringtoneController.getRingtoneById);
router.post('/', upload.single('logo'), ringtoneController.createRingtone);
router.put('/:id', upload.single('logo'), ringtoneController.updateRingtone);
router.delete('/:id', ringtoneController.deleteRingtone);
router.get('/:id/songs', ringtoneController.getRingtoneSongs);

module.exports = router;
