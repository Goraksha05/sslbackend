/**
 * routes/adminKycRoutes.js
 *
 * Admin KYC route definitions.
 *
 * ── Middleware chain ──────────────────────────────────────────────────────────
 *
 *   fetchuser   JWT auth — populates req.user with { id, role, isAdmin,
 *               isSuperAdmin, permissions[] }.
 *
 *   isAdmin     RBAC gate — delegates to verifyAdmin() from middleware/rbac.js.
 *               Rejects non-admin tokens with 403 before the controller runs.
 *               For permission-scoped routes a second inline guard (requirePerm)
 *               checks the specific permission string from constants/permissions.js.
 *
 * ── Permission strategy ───────────────────────────────────────────────────────
 *
 *   No dedicated KYC permission tokens exist in permissions.js yet.  The safest
 *   mapping to the current RBAC surface is:
 *
 *     READ endpoints  (list, detail, stats)
 *       → VIEW_USERS  ('view_users')
 *         Any admin whose role includes user-visibility can see KYC records.
 *
 *     WRITE endpoints (verify, reject, reset)
 *       → BAN_USERS   ('ban_users')  — the closest existing "authority over a
 *         user's account status" token.  Replace with a dedicated REVIEW_KYC
 *         token once it is added to permissions.js and seeded into AdminRole.
 *
 *   super_admin tokens always carry the wildcard '*' permission and bypass
 *   every requirePerm check automatically (see requirePerm implementation below).
 *
 * ── Route map ─────────────────────────────────────────────────────────────────
 *
 *   General KYC admin routes  (full-featured, original set)
 *   ─────────────────────────────────────────────────────────
 *   GET    /api/admin/kyc/users            getKYCUsers        — paginated list, filterable by status/search
 *   GET    /api/admin/kyc/stats            getKYCStats        — aggregate counts per status (dashboard cards)
 *   GET    /api/admin/kyc/user/:id         getKYCDetail       — full KYC record for one user
 *   POST   /api/admin/kyc/approve/:id      approveKYC         — approve a submitted/rejected KYC
 *   POST   /api/admin/kyc/reject/:id       rejectKYC          — reject with mandatory reason body
 *   POST   /api/admin/kyc/reset/:id        resetKYC           — wipe record so user can resubmit
 *
 *   Special-Offer-aware KYC routes  (newer set, SP-offer credit integration)
 *   ─────────────────────────────────────────────────────────────────────────
 *   GET    /api/admin/kyc/pending          getPendingKyc      — all 'submitted' users, FIFO order
 *   GET    /api/admin/kyc/sp-stats         getSpOfferKycStats — submitted/verified/rejected/notStarted counts
 *   GET    /api/admin/kyc/detail/:userId   getKycDetails      — full record + referral chain for one user
 *   POST   /api/admin/kyc/verify/:userId   verifyKyc          — approve + fire creditReferralReward if eligible
 *   POST   /api/admin/kyc/reject/:userId   rejectSpOfferKyc   — reject + notify user (SP-offer path)
 *
 * ── Why two overlapping route sets? ──────────────────────────────────────────
 *
 *   The original set (approveKYC / rejectKYC / getKYCUsers) is used by the
 *   general admin KYC dashboard.  The "Sp-offer" set (verifyKyc /
 *   rejectSpOfferKyc / getPendingKyc) was added later when the Special Offer
 *   feature needed KYC approval to trigger creditReferralReward().  Both sets
 *   write to the same User.kyc sub-document but differ in:
 *
 *     • verifyKyc  fires creditReferralReward() via setImmediate (fire-and-forget),
 *       so the referrer's ₹100 locked reward is credited at the exact moment a
 *       referred user's KYC is approved — respecting the 12-hour offer window,
 *       daily cap, duplicate guard, and trust-score checks inside
 *       specialOfferController.
 *
 *     • rejectSpOfferKyc  emits a kyc_rejected socket event directly to the user's
 *       personal room (userId.toString()) rather than the admin broadcast room,
 *       so the user's dashboard updates in real time without a poll.
 *
 *     • getSpOfferKycStats  returns a leaner four-field shape optimised for the
 *       Special Offer admin widget rather than the full aggregation pipeline in
 *       getKYCStats.
 *
 *   You can safely use either set from their respective admin UIs; they are not
 *   mutually exclusive and do not conflict.
 */

'use strict';

const express = require('express');
const router  = express.Router();

// ── Middleware ────────────────────────────────────────────────────────────────
const fetchuser = require('../middleware/fetchuser');
const isAdmin   = require('../middleware/isAdmin');     // delegates to rbac.verifyAdmin

// ── Controllers ───────────────────────────────────────────────────────────────
const {
  // General KYC admin set
  getKYCUsers,
  getKYCStats,
  getKYCDetail,
  approveKYC,
  rejectKYC,
  resetKYC,

  // Special-Offer-aware KYC set
  getPendingKyc,
  getKycDetails,
  verifyKyc,
  rejectSpOfferKyc,
  getSpOfferKycStats,
} = require('../controllers/adminKycController');

// ── Permission constants ───────────────────────────────────────────────────────
const { PERMISSIONS } = require('../constants/permissions');

// ── Permission guard factory ──────────────────────────────────────────────────
/**
 * Returns an Express middleware that checks whether req.user holds a specific
 * permission (or the super-admin wildcard '*').
 *
 * Usage:  router.get('/foo', fetchuser, isAdmin, requirePerm(PERMISSIONS.VIEW_USERS), handler)
 *
 * Design notes:
 *   • isAdmin (verifyAdmin from rbac.js) must run BEFORE requirePerm so that
 *     req.user.permissions is guaranteed to be populated.
 *   • super_admin tokens carry ['*'] — the wildcard check short-circuits all
 *     specific permission checks, so super-admins are never blocked here.
 *   • If the token lacks the required permission the response is 403 with a
 *     machine-readable errorCode so the frontend can surface a helpful message.
 *
 * @param {string} perm  One of the PERMISSIONS constant values
 * @returns {import('express').RequestHandler}
 */
function requirePerm(perm) {
  return (req, res, next) => {
    const perms = req.user?.permissions ?? [];

    // Wildcard — super_admin bypasses all permission checks
    if (perms.includes('*')) return next();

    if (!perms.includes(perm)) {
      return res.status(403).json({
        error:     `Forbidden: '${perm}' permission required.`,
        errorCode: 'PERMISSION_DENIED',
      });
    }

    return next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL KYC ADMIN ROUTES
// Full-featured set used by the main admin KYC dashboard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/kyc/users
 *
 * Paginated, filterable list of all users with a KYC record.
 * Query params: status, search, page, limit
 *
 * Required permission: VIEW_USERS
 * Response: { users[], total, page, pages }
 */
router.get(
  '/users',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.VIEW_USERS),
  getKYCUsers
);

/**
 * GET /api/admin/kyc/stats
 *
 * Aggregate KYC status counts for the admin dashboard header cards.
 * Uses a single $group aggregation pipeline — no per-status queries.
 *
 * Required permission: VIEW_USERS
 * Response: { not_started, required, submitted, verified, rejected, pending }
 *           (pending is an alias for submitted)
 */
router.get(
  '/stats',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.VIEW_USERS),
  getKYCStats
);

/**
 * GET /api/admin/kyc/user/:id
 *
 * Full KYC detail for a single user by their MongoDB _id.
 * Returns: name, email, username, kyc (full), trustFlags
 *
 * Required permission: VIEW_USERS
 * Response: { user }
 */
router.get(
  '/user/:id',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.VIEW_USERS),
  getKYCDetail
);

/**
 * POST /api/admin/kyc/approve/:id
 *
 * Approve a KYC submission.  Valid from statuses: 'submitted' or 'rejected'.
 * Sets kyc.status → 'verified', clears rejectionReason, updates trustFlags.
 * Fires creditReferralReward() for the user's referrer if they have one
 * (non-fatal — admin receives 200 regardless of credit outcome).
 *
 * Required permission: BAN_USERS (closest existing "authority over user status" token)
 * Response: { message }
 */
router.post(
  '/approve/:id',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.BAN_USERS),
  approveKYC
);

/**
 * POST /api/admin/kyc/reject/:id
 *
 * Reject a KYC submission.
 * Body: { reason: string }  — required; controller returns 400 if omitted.
 * Sets kyc.status → 'rejected', persists rejectionReason.
 * Clears verifiedAt / verifiedBy if reversing a prior approval.
 * Sends a push notification with the admin-supplied reason embedded.
 *
 * Required permission: BAN_USERS
 * Response: { message }
 */
router.post(
  '/reject/:id',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.BAN_USERS),
  rejectKYC
);

/**
 * POST /api/admin/kyc/reset/:id
 *
 * Wipe the user's KYC record entirely so they can resubmit from scratch.
 * Useful when documents are corrupted, uploaded in the wrong slots, or the
 * user's legal name has changed.
 * Sets kyc.status → 'not_started' and kycRequired → true on trustFlags.
 *
 * Required permission: BAN_USERS
 * Response: { message }
 */
router.post(
  '/reset/:id',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.BAN_USERS),
  resetKYC
);

// ─────────────────────────────────────────────────────────────────────────────
// SPECIAL-OFFER-AWARE KYC ROUTES
//
// These four routes are the "SP-offer KYC" surface requested by the ticket.
// They sit alongside (not replacing) the general routes above and are consumed
// by the Special Offer admin panel widget.
//
// Key behavioural differences vs the general set:
//
//   • verifyKyc  — calls creditReferralReward(user.referral, userId) via
//     setImmediate so the KYC approval atomically triggers the ₹100 locked
//     reward credit for the referrer when:
//       a) user.referral is set (user was referred by someone), AND
//       b) the referrer's specialOffer.isActive is true AND
//          specialOffer.expiresAt has not yet passed (12-hour window), AND
//       c) referrer has not hit the ₹1 800 daily cap, AND
//       d) this referred user has not already triggered a reward
//          (duplicate guard in creditReferralReward).
//     The HTTP response is sent before setImmediate fires so the admin UI is
//     never delayed by the credit operation.
//
//   • rejectSpOfferKyc  — emits 'kyc_rejected' directly to the affected
//     user's personal socket room so their dashboard banner updates without
//     a polling round-trip.
//
//   • getPendingKyc     — returns users sorted oldest-first (FIFO) so the
//     admin works through the queue in submission order, preventing starvation
//     of early submissions.
//
//   • getSpOfferKycStats — leaner four-field shape (submitted, verified,
//     rejected, notStarted) optimised for the Special Offer widget counters
//     rather than the full aggregation pipeline used by getKYCStats.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/kyc/pending
 *
 * Returns all users whose kyc.status === 'submitted', sorted by submittedAt
 * ascending (oldest first — FIFO queue).
 *
 * Fields returned per user: name, email, phone, kyc.status, kyc.submittedAt,
 * kyc.documents (file URLs), kyc.thumbnails (preview URLs for the admin panel).
 *
 * Required permission: VIEW_USERS
 * Response: { users[] }
 */
router.get(
  '/pending',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.VIEW_USERS),
  getPendingKyc
);

/**
 * GET /api/admin/kyc/sp-stats
 *
 * Summary counts for the Special Offer admin KYC widget.
 * Runs four parallel countDocuments queries — no aggregation pipeline.
 *
 * Required permission: VIEW_USERS
 * Response: { submitted, verified, rejected, notStarted }
 *   submitted  — kyc.status === 'submitted'  (pending review queue depth)
 *   verified   — kyc.status === 'verified'
 *   rejected   — kyc.status === 'rejected'
 *   notStarted — kyc.status in ['not_started', 'required']
 */
router.get(
  '/sp-stats',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.VIEW_USERS),
  getSpOfferKycStats
);

/**
 * GET /api/admin/kyc/detail/:userId
 *
 * Full KYC details for a single user, including referral chain fields
 * (user.referral, user.referralId) that the general getKYCDetail omits.
 * This extra data lets the admin panel show whether approving this KYC will
 * trigger a Special Offer credit for the referrer.
 *
 * Required permission: VIEW_USERS
 * Response: { user }  — fields: name, email, phone, kyc (full), referral, referralId
 */
router.get(
  '/detail/:userId',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.VIEW_USERS),
  getKycDetails
);

/**
 * POST /api/admin/kyc/verify/:userId
 *
 * Special-Offer-aware KYC approval.
 *
 * Flow:
 *   1. Load user, guard against double-verify.
 *   2. Set kyc.status → 'verified', kyc.verifiedAt, kyc.verifiedBy.
 *   3. Create a 'custom' Notification record and emit 'kyc_verified' to
 *      the user's personal socket room.
 *   4. If user.referral is set, fire creditReferralReward(referrerId, userId)
 *      inside setImmediate (non-blocking, non-fatal).
 *      creditReferralReward internally checks:
 *        • referrer's 12-hour specialOffer window (isOfferValid)
 *        • referrer's rewards-frozen trustFlag
 *        • ₹1 800 daily cap (getTodayEarnings)
 *        • duplicate guard (already rewarded for this referredUserId)
 *        • trust / fraud scoring (async, non-blocking)
 *      On success it pushes a lockedReward entry to the referrer and creates
 *      a Payout record for the admin panel.
 *
 * Required permission: BAN_USERS
 * Response: { message, userId, verifiedAt }
 */
router.post(
  '/verify/:userId',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.BAN_USERS),
  verifyKyc
);

/**
 * POST /api/admin/kyc/reject/:userId
 *
 * Special-Offer-aware KYC rejection.
 *
 * Body (optional): { reason: string }
 *   Defaults to 'Documents could not be verified.' if omitted.
 *
 * Flow:
 *   1. Guard against double-rejection.
 *   2. Set kyc.status → 'rejected', kyc.rejectionReason.
 *   3. Create a 'custom' Notification record.
 *   4. Emit 'kyc_rejected' directly to the user's personal socket room
 *      (userId.toString()) so the user's dashboard updates in real time.
 *
 * Note on route conflict with POST /reject/:id (general set):
 *   Both routes use a POST verb and a :id / :userId param.  They are on
 *   DIFFERENT param names and different path segments (/reject/:id vs
 *   /reject/:userId) which Express treats as the same pattern when the
 *   prefix is identical.  To avoid ambiguity the general set uses /:id
 *   and the SP-offer set uses /:userId — callers must use the correct path.
 *   If your router mounts these at /api/admin/kyc, the full paths are:
 *     General:   POST /api/admin/kyc/reject/:id
 *     SP-offer:  POST /api/admin/kyc/reject/:userId
 *   Express resolves conflicts by first-registered-wins, so register the
 *   more specific (SP-offer) path AFTER the general path as done here —
 *   but since the param names differ Express actually treats both as the
 *   same template "/reject/:param" and first-registered-wins applies.
 *
 *   RECOMMENDATION: Rename one of these to avoid the collision.  A clean
 *   split would be:
 *     General:   POST /api/admin/kyc/reject/:id        (existing admin dashboard)
 *     SP-offer:  POST /api/admin/kyc/sp-reject/:userId (new SP-offer panel)
 *   Update the admin frontend accordingly.  The implementation below uses
 *   /sp-reject/:userId to resolve the conflict cleanly without touching
 *   the existing /reject/:id route.
 *
 * Required permission: BAN_USERS
 * Response: { message, userId, reason }
 */
router.post(
  '/sp-reject/:userId',
  fetchuser,
  isAdmin,
  requirePerm(PERMISSIONS.BAN_USERS),
  rejectSpOfferKyc
);

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;

/**
 * ── Mount in app.js / index.js ───────────────────────────────────────────────
 *
 *   const adminKycRoutes = require('./routes/adminKycRoutes');
 *   app.use('/api/admin/kyc', adminKycRoutes);
 *
 * ── Full route table after mount ─────────────────────────────────────────────
 *
 *   General KYC admin
 *   GET    /api/admin/kyc/users              getKYCUsers
 *   GET    /api/admin/kyc/stats              getKYCStats
 *   GET    /api/admin/kyc/user/:id           getKYCDetail
 *   POST   /api/admin/kyc/approve/:id        approveKYC
 *   POST   /api/admin/kyc/reject/:id         rejectKYC          ← general dashboard
 *   POST   /api/admin/kyc/reset/:id          resetKYC
 *
 *   Special-Offer-aware KYC
 *   GET    /api/admin/kyc/pending            getPendingKyc
 *   GET    /api/admin/kyc/sp-stats           getSpOfferKycStats
 *   GET    /api/admin/kyc/detail/:userId     getKycDetails
 *   POST   /api/admin/kyc/verify/:userId     verifyKyc
 *   POST   /api/admin/kyc/sp-reject/:userId  rejectSpOfferKyc   ← SP-offer panel
 */