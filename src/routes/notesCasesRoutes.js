const express = require('express');
const router = express.Router();
const notesCasesController = require('../controllers/notesCasesController');

// Specific sub-routes (Must precede generic /:id parameter)
router.get('/search', notesCasesController.searchNotesCases);
router.get('/export', notesCasesController.exportNotesCases);

// Collection routes (supports both '/' and '')
router.route('/')
  .get(notesCasesController.getNotesCases)
  .post(notesCasesController.createNotesCase);

router.route('')
  .get(notesCasesController.getNotesCases)
  .post(notesCasesController.createNotesCase);

// Individual resource routes
router.get('/:id', notesCasesController.getNotesCaseById);
router.put('/:id', notesCasesController.updateNotesCase);
router.delete('/:id', notesCasesController.deleteNotesCase);

// Situation sub-resource
router.post('/:id/situations', notesCasesController.addSituation);
router.put('/:id/situations/:sitId', notesCasesController.updateSituation);
router.delete('/:id/situations/:sitId', notesCasesController.deleteSituation);

module.exports = router;
