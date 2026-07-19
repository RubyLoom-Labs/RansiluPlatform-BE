const express = require('express');
const router = express.Router();
const distributorController = require('../controllers/distributorController');

router.get('/', distributorController.getDistributors);
router.get('/:id', distributorController.getDistributorById);
router.get('/:id/songs', distributorController.getDistributorSongs);
router.post('/', distributorController.createDistributor);
router.put('/:id', distributorController.updateDistributor);
router.put('/:id/inactivate', distributorController.inactivateDistributor);
router.delete('/:id', distributorController.deleteDistributor);

module.exports = router;
