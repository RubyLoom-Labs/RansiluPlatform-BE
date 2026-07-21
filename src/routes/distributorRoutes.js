const express = require('express');
const router = express.Router();
const distributorController = require('../controllers/distributorController');

router.get('/', distributorController.getDistributors);
router.post('/', distributorController.createDistributor);

// Specific sub-routes BEFORE generic /:id to avoid path conflicts
router.put('/:id/inactivate', distributorController.inactivateDistributor);
router.put('/:id/activate', distributorController.activateDistributor);
router.patch('/reactivate/:id', distributorController.activateDistributor);
router.patch('/:id/reactivate', distributorController.activateDistributor);
router.get('/:id/songs', distributorController.getDistributorSongs);
router.get('/:id/conflicts', distributorController.getDistributorConflicts);

router.get('/:id', distributorController.getDistributorById);
router.put('/:id', distributorController.updateDistributor);
router.delete('/:id', distributorController.deleteDistributor);

module.exports = router;
