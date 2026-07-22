const express = require('express');
const router = express.Router();
const artistController = require('../controllers/artistController');
const upload = require('../middlewares/upload');

router.get('/', artistController.getArtists);
router.get('/:id', artistController.getArtistById);
router.get('/:id/songs', artistController.getArtistSongs);
router.get('/:id/albums', artistController.getArtistAlbums);
router.post('/check-name', artistController.checkArtistName);
router.post('/', upload.single('image'), artistController.createArtist);
router.put('/:id', upload.single('image'), artistController.updateArtist);
router.delete('/:id', artistController.deleteArtist);

module.exports = router;
