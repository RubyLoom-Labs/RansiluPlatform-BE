const express = require('express');
const router = express.Router();
const albumController = require('../controllers/albumController');

// Specific sub-routes (Must precede generic /:id parameter)
router.get('/search', albumController.searchAlbums);
router.get('/export', albumController.exportAlbums);
router.get('/record-labels/dropdown', albumController.getRecordLabelDropdown);
router.get('/songs/dropdown', albumController.getSongDropdown);

// Collection routes
router.get('/', albumController.getAlbums);
router.post('/', albumController.createAlbum);

// Individual resource routes
router.get('/:id', albumController.getAlbumById);
router.get('/:id/songs', albumController.getAlbumSongs);
router.put('/:id', albumController.updateAlbum);
router.delete('/:id', albumController.deleteAlbum);

module.exports = router;
