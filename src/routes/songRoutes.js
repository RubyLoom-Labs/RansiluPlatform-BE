const express = require('express');
const router = express.Router();
const songController = require('../controllers/songController');
const upload = require('../middlewares/upload');

router.get('/', songController.getSongs);
router.get('/:id', songController.getSongById);
router.post('/check-name', songController.checkSongName);

router.get('/:id/inactivate-check', songController.checkSongInactivationDependencies);
router.get('/:id/delete-check', songController.checkSongDeleteDependencies);
router.post('/:id/inactivate', songController.inactivateSong);
router.post('/:id/activate', songController.activateSong);
router.delete('/:id', songController.deleteSong);

router.get('/:id/ownership', songController.getSongOwnership);
router.delete('/:id/ownership/:mappingId', songController.deleteSongOwnership);
router.get('/:id/albums', songController.getSongAlbumsAndLabels);
router.delete('/:id/albums/:albumId', songController.removeSongAlbumRelationship);
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

