const express = require('express');
const router = express.Router();
const ownershipController = require('../controllers/ownershipController');
const upload = require('../middlewares/upload');

// Specific sub-routes (Must precede generic /:id parameter)
router.get('/search', ownershipController.searchOwnership);
router.get('/export', ownershipController.exportOwnership);

// Collection routes (supports both '/' and '')
router.route('/')
  .get(ownershipController.getOwnerships)
  .post(upload.any(), ownershipController.createOwnership);

router.route('')
  .get(ownershipController.getOwnerships)
  .post(upload.any(), ownershipController.createOwnership);

// Individual resource routes
router.get('/:id', ownershipController.getOwnershipById);
router.post('/:id/songs', ownershipController.addSongsToOwnership);
router.put('/:id', upload.any(), ownershipController.updateOwnership);
router.delete('/:id', ownershipController.deleteOwnership);

module.exports = router;
