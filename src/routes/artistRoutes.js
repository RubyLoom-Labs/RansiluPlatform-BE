const express = require('express');
const router = express.Router();
const artistController = require('../controllers/artistController');
const upload = require('../middlewares/upload');

router.get('/', artistController.getArtists);
router.post('/check-name', artistController.checkArtistName);
router.post('/', upload.single('image'), artistController.createArtist);
router.put('/:id', upload.single('image'), artistController.updateArtist);

module.exports = router;
