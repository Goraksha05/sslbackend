// routes/payoutRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Payout management routes for the admin panel.
//
// All routes in this file require:
//   1. fetchUser   — validates JWT and populates req.user (applied at the
//                    adminRouter level in index.js — no need to re-apply here)
//   2. isAdmin     — ensures role is 'admin' or 'super_admin' (also applied
//                    at the adminRouter level in index.js)
//   3. checkPermission('manage_payouts') — per-route RBAC guard; only admins
//                    whose role includes the 'manage_payouts' permission token
//                    (defined in constants/permissions.js ROLE_PRESETS.finance_admin)
//                    can call these endpoints.
//
// Mounted in index.js as part of the protected adminRouter:
//   adminRouter.use(require('./routes/payoutRoutes'));
//
// Final URL prefix after index.js mounts adminRouter at /api/admin:
//   /api/admin/payouts/...
//
// Full route table:
//   GET    /api/admin/payouts                   listPayouts
//   GET    /api/admin/payouts/summary           getPayoutSummary
//   GET    /api/admin/payouts/pending-claims    listPendingClaims
//   GET    /api/admin/payouts/user/:userId      getUserPayouts
//   POST   /api/admin/payouts/process           processPayout
//   PATCH  /api/admin/payouts/:payoutId/status  updatePayoutStatus
//   POST   /api/admin/payouts/bulk-process      bulkProcessPayouts
//
// ORDERING NOTE:
//   Express matches routes in registration order.
//   Static segments (/summary, /pending-claims, /process, /bulk-process) are
//   registered BEFORE the dynamic segment (/user/:userId and /:payoutId/status)
//   to prevent Express from mistaking e.g. "summary" for a userId or payoutId.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const { checkPermission } = require('../middleware/rbac');

const {
  listPayouts,
  getPayoutSummary,
  listPendingClaims,
  getUserPayouts,
  processPayout,
  updatePayoutStatus,
  bulkProcessPayouts,
} = require('../controllers/financeAndPayoutController');

// Convenience alias — every payout route requires this permission.
// 'manage_payouts' is included in the finance_admin role preset
// (see constants/permissions.js → ROLE_PRESETS.finance_admin).
const requirePayoutPerm = checkPermission('manage_payouts');

// ── Static-segment routes first (must come before /:payoutId) ─────────────────

// GET /api/admin/payouts/summary
// INR dashboard totals: paid / pending / on_hold / failed, broken down by
// reward type and plan key. Used by AdminFinancial.js charts.
router.get('/payouts/summary', requirePayoutPerm, getPayoutSummary);

// GET /api/admin/payouts/pending-claims
// All RewardClaims that have no Payout record yet, enriched with slab
// resolution and estimated INR amount. The primary queue admins work from.
// Query params: page, limit, type (post|referral|streak), minINR, bankOnly
router.get('/payouts/pending-claims', requirePayoutPerm, listPendingClaims);

// POST /api/admin/payouts/process
// Create a payout for a single RewardClaim.
// Body: { claimId, status?, transactionRef?, notes? }
router.post('/payouts/process', requirePayoutPerm, processPayout);

// POST /api/admin/payouts/bulk-process
// Process up to 100 RewardClaims in one request (end-of-month batch runs).
// Body: { claimIds: string[], status?: 'processing'|'paid', notes? }
// Response: HTTP 207 Multi-Status with per-claim results.
router.post('/payouts/bulk-process', requirePayoutPerm, bulkProcessPayouts);

// ── Dynamic-segment routes ─────────────────────────────────────────────────────

// GET /api/admin/payouts/user/:userId
// All payout records + aggregated totals for one specific user.
// Used by the user-detail drawer in the admin panel.
router.get('/payouts/user/:userId', requirePayoutPerm, getUserPayouts);

// PATCH /api/admin/payouts/:payoutId/status
// Transition a payout through its lifecycle:
//   pending → processing → paid
//                        ↘ failed   (retry: failed → pending)
//                        ↘ on_hold  (resume: on_hold → pending)
// Body: { status, transactionRef?, failureReason? (required for 'failed'), notes? }
router.patch('/payouts/:payoutId/status', requirePayoutPerm, updatePayoutStatus);

// ── Main list (last — broadest match) ─────────────────────────────────────────

// GET /api/admin/payouts
// Paginated payout list with optional filters.
// Query params: page, limit, status, rewardType, userId, from, to
router.get('/payouts', requirePayoutPerm, listPayouts);

module.exports = router;