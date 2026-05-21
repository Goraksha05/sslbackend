/**
 * routes/specialOfferRoutes.js
 *
 * Mount in index.js:
 *   app.use('/api/special-offer', require('./routes/specialOfferRoutes'));
 *
 * Routes:
 *   GET  /api/special-offer/status          — offer status for logged-in user
 *   GET  /api/special-offer/locked-rewards  — locked rewards list
 *   POST /api/special-offer/withdraw        — user-initiated withdrawal of approved rewards
 */

'use strict';

const express   = require('express');
const router    = express.Router();
const fetchUser = require('../middleware/fetchuser');
const ctrl      = require('../controllers/specialOfferController');

router.get('/status',               fetchUser, ctrl.getStatus);
router.get('/locked-rewards',       fetchUser, ctrl.getLockedRewards);
router.post('/request-withdrawal',  fetchUser, ctrl.requestWithdrawal);
router.post('/withdrawal-preview',  fetchUser, ctrl.getWithdrawalPreview);
router.post('/withdraw',            fetchUser, ctrl.withdraw);

module.exports = router;