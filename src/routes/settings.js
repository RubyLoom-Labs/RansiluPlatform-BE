const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

// Users routes
router.get('/users', settingsController.getUsers);
router.post('/users', settingsController.createUser);
router.put('/users/:id', settingsController.updateUser);
router.delete('/users/:id', settingsController.deleteUser);

// Roles routes
router.get('/roles', settingsController.getRoles);
router.get('/roles/:id', settingsController.getRoleById);
router.post('/roles', settingsController.createRole);
router.put('/roles/:id', settingsController.updateRole);
router.delete('/roles/:id', settingsController.deleteRole);

// Permissions route
router.get('/permissions', settingsController.getPermissions);

// User Logs route
router.get('/logs', settingsController.getLogs);

module.exports = router;
