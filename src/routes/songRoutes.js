const express = require('express');
const router = express.Router();
const songController = require('../controllers/songController');
const upload = require('../middlewares/upload');

router.get('/', songController.getSongs);
router.get('/:id', songController.getSongById);
router.post('/check-name', songController.checkSongName);

// Song-scoped sub-resource endpoints
router.get('/:id/distributions', songController.getSongDistributions);
router.get('/:id/ringtones', songController.getSongRingtones);
router.post('/:id/ringtones', songController.addSongRingtone);
router.patch('/:id/ringtones/:ringtoneId/remove', songController.removeSongRingtone);
router.get('/:id/versions', songController.getSongVersions);
router.get('/:id/conflicts', songController.getSongConflicts);
router.post('/:id/conflicts', songController.createSongConflict);
router.patch('/:id/conflicts/:conflictId/resolve', songController.resolveSongConflict);
router.patch('/:id/conflicts/:conflictId/delete', songController.deleteSongConflict);

router.post(
  '/',
  upload.fields([
    { name: 'track', maxCount: 1 },
    { name: 'art', maxCount: 1 },
  ]),
  songController.createSong
);
router.put(
  '/:id',
  upload.fields([
    { name: 'track', maxCount: 1 },
    { name: 'art', maxCount: 1 },
  ]),
  songController.updateSong
);

module.exports = router;

