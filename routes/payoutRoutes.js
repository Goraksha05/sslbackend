// routes/payoutRoutes.js  (UPDATED)
// ─────────────────────────────────────────────────────────────────────────────
// Payout management routes for the admin panel.
//
// CHANGES:
//   NEW — GET /api/admin/payouts/report           getPayoutReport
//   NEW — GET /api/admin/payouts/user-requested   listUserRequestedPayouts
//
// Route order: all static-segment routes BEFORE dynamic /:payoutId routes.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { checkPermission } = require('../middleware/rbac');

const {
  listPayouts,
  getPayoutSummary,
  listPendingClaims,
  listUserRequestedPayouts,
  getUserPayouts,
  processPayout,
  updatePayoutStatus,
  bulkProcessPayouts,
  listUnredeemedWallets,
  getPayoutReport,
} = require('../controllers/financeAndPayoutController');

const requirePayoutPerm = checkPermission('manage_payouts');

// ── Static-segment routes (must come before /:payoutId) ───────────────────────

// GET /api/admin/payouts/summary
router.get('/payouts/summary', requirePayoutPerm, getPayoutSummary);

// GET /api/admin/payouts/pending-claims
// Shows RewardClaims without a Payout. For grocery_redeem: only user-requested.
router.get('/payouts/pending-claims', requirePayoutPerm, listPendingClaims);

// GET /api/admin/payouts/user-requested
// NEW: Lists only user-initiated grocery redemption requests (userRequested:true).
// These are the payouts admin is responsible for paying.
router.get('/payouts/user-requested', requirePayoutPerm, listUserRequestedPayouts);

// GET /api/admin/payouts/report
// NEW: Full payout report with bank details — data for Excel download.
// Query: format=all|paid|pending, rewardType, from, to, userRequested
router.get('/payouts/report', requirePayoutPerm, getPayoutReport);

// GET /api/admin/payouts/unredeemed-wallets
// Shows users with wallet balance who haven't submitted a redemption request.
// Admin does NOT auto-pay these — they must wait for user to request.
router.get('/payouts/unredeemed-wallets', requirePayoutPerm, listUnredeemedWallets);

// POST /api/admin/payouts/process
router.post('/payouts/process', requirePayoutPerm, processPayout);

// POST /api/admin/payouts/bulk-process
router.post('/payouts/bulk-process', requirePayoutPerm, bulkProcessPayouts);

// ── Dynamic-segment routes ─────────────────────────────────────────────────────

// GET /api/admin/payouts/user/:userId
router.get('/payouts/user/:userId', requirePayoutPerm, getUserPayouts);

// PATCH /api/admin/payouts/:payoutId/status
router.patch('/payouts/:payoutId/status', requirePayoutPerm, updatePayoutStatus);

// GET /api/admin/payouts — paginated list (broadest match — last)
router.get('/payouts', requirePayoutPerm, listPayouts);

module.exports = router;