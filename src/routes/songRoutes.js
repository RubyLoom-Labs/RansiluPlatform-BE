const express = require('express');
const router = express.Router();
const songController = require('../controllers/songController');
const upload = require('../middlewares/upload');

router.get('/', songController.getSongs);
router.post(
  '/',
  upload.fields([
    { name: 'track', maxCount: 1 },
    { name: 'art', maxCount: 1 },
  ]),
  songController.createSong
);

module.exports = router;
