const express = require('express');
const router = express.Router();
const distributorController = require('../controllers/distributorController');

router.get('/', distributorController.getDistributors);
router.get('/:id', distributorController.getDistributorById);
router.post('/', distributorController.createDistributor);
router.put('/:id', distributorController.updateDistributor);

module.exports = router;
