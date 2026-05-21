// routes/payoutRoutes.js  (FIXED)
// ─────────────────────────────────────────────────────────────────────────────
// Payout management routes for the admin panel.
//
// FIX: GET /payouts/special-offer-report moved into the static-segment block.
//      It was previously declared after the /:payoutId dynamic routes and was
//      therefore unreachable — Express would match /payouts/special-offer-report
//      against /payouts/user/:userId or let it fall through entirely.
//
// Rule: every fixed-string path segment must be registered before any route
//       that introduces a dynamic segment (/:param) at the same position.
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
  getSpecialOfferReport,
} = require('../controllers/financeAndPayoutController');

const requirePayoutPerm = checkPermission('manage_payouts');

// ── Static-segment routes (must come before /:payoutId) ───────────────────────

// GET /api/admin/payouts/summary
router.get('/payouts/summary', requirePayoutPerm, getPayoutSummary);

// GET /api/admin/payouts/pending-claims
// Shows RewardClaims without a Payout. For grocery_redeem: only user-requested.
router.get('/payouts/pending-claims', requirePayoutPerm, listPendingClaims);

// GET /api/admin/payouts/user-requested
// Lists only user-initiated grocery redemption requests (userRequested:true).
// These are the payouts admin is responsible for paying.
router.get('/payouts/user-requested', requirePayoutPerm, listUserRequestedPayouts);

// GET /api/admin/payouts/report
// Full payout report with bank details — data for Excel download.
// Query: format=all|paid|pending, rewardType, from, to, userRequested
router.get('/payouts/report', requirePayoutPerm, getPayoutReport);

// GET /api/admin/payouts/special-offer-report
// FIXED: moved here from below the dynamic routes where it was unreachable.
// Full Special Offer payout report: rows[], summary{}, total, generated.
// Query: format=all|paid|pending, path=credit|withdrawal, status, from, to, userId
router.get('/payouts/special-offer-report', requirePayoutPerm, getSpecialOfferReport);

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

// GET /api/admin/payouts — paginated list
router.get('/payouts', requirePayoutPerm, listPayouts);

module.exports = router;