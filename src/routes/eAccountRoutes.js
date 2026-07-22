const express = require('express');
const router = express.Router();
const eAccountController = require('../controllers/eAccountController');

router.get('/', eAccountController.getEAccounts);
router.post('/', eAccountController.createEAccount);
router.put('/:id', eAccountController.updateEAccount);
router.delete('/:id', eAccountController.deleteEAccount);

module.exports = router;
