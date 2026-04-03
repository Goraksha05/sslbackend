/**
 * routes/adminActivityReportRoutes.js
 *
 * Mounted inside the protected adminRouter in index.js:
 *   adminRouter.use(require('./routes/adminActivityReportRoutes'));
 *
 * Routes:
 *   GET /api/admin/reports/activity          — paginated list
 *   GET /api/admin/reports/activity/export   — full export (max 5000)
 *   GET /api/admin/reports/activity/:userId  — single user detail
 */

'use strict';

const express    = require('express');
const router     = express.Router();
const { checkPermission } = require('../middleware/rbac');
const ctrl = require('../controllers/adminActivityReportController');

const requireReportAccess = checkPermission('view_reports');

// IMPORTANT: /export must be registered BEFORE /:userId to avoid Express
// treating the string "export" as a userId parameter.
router.get('/reports/activity/export',    requireReportAccess, ctrl.exportActivityReport);
router.get('/reports/activity/:userId',   requireReportAccess, ctrl.getUserActivityDetail);
router.get('/reports/activity',           requireReportAccess, ctrl.listActivityReport);

module.exports = router;