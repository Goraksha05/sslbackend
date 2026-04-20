// controllers/financeAndPayoutController.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin payout management for the three user activity reward types:
//   • post     — milestone slabs: 30 / 70 / 150 / 300 / 600 / 1000 posts
//   • referral — milestone slabs: 3 / 6 / 10 (big) + 11–30 (token-only)
//   • streak   — milestone slabs: 30 / 60 / 90 / … / 360 days
//
// ── REWARD CURRENCY MODEL ────────────────────────────────────────────────────
// Every slab contains three reward currencies. Only ONE is a cash reward:
//
//   groceryCoupons  →  CASH reward  (₹ face value) — paid out to user's bank
//   shares          →  OBJECT reward (units held)   — NOT paid as cash yet
//   referralToken   →  OBJECT reward (tokens held)  — NOT paid as cash yet
//
// When the admin clicks "Pay", ONLY the groceryCoupons value is transferred.
// Shares and tokens are recorded in objectRewardsHeld for future processing.
// Their separate redemption flow will be built separately.
//
// The Payout document carries:
//   cashAmountINR      — the ₹ amount actually sent to the bank (coupons only)
//   objectRewardsHeld  — { sharesHeld, referralTokenHeld } for audit trail
//   totalAmountINR     — set equal to cashAmountINR (legacy field kept for compat)
//
// Payout lifecycle:
//   pending → processing → paid
//                        ↘ failed   (retryable: failed → pending)
//                        ↘ on_hold  (manual review: on_hold → pending)
//
// Routes (all mounted under /api/admin/payouts via adminRoutes.js):
//   GET    /                   listPayouts          — paginated list + filters
//   GET    /summary            getPayoutSummary     — INR totals dashboard
//   GET    /pending-claims     listPendingClaims    — RewardClaims awaiting payout
//   GET    /user/:userId       getUserPayouts       — all payouts for one user
//   POST   /process            processPayout        — create payout for one claim
//   PATCH  /:payoutId/status   updatePayoutStatus   — transition payout status
//   POST   /bulk-process       bulkProcessPayouts   — batch payout creation (max 100)
//
// Wire-up snippet for adminRoutes.js:
//   const payout = require('../controllers/financeAndPayoutController');
//   router.get(   '/payouts',                  fetchUser, isAdmin, checkPermission('manage_payouts'), payout.listPayouts);
//   router.get(   '/payouts/summary',          fetchUser, isAdmin, checkPermission('manage_payouts'), payout.getPayoutSummary);
//   router.get(   '/payouts/pending-claims',   fetchUser, isAdmin, checkPermission('manage_payouts'), payout.listPendingClaims);
//   router.get(   '/payouts/user/:userId',     fetchUser, isAdmin, checkPermission('manage_payouts'), payout.getUserPayouts);
//   router.post(  '/payouts/process',          fetchUser, isAdmin, checkPermission('manage_payouts'), payout.processPayout);
//   router.patch( '/payouts/:payoutId/status', fetchUser, isAdmin, checkPermission('manage_payouts'), payout.updatePayoutStatus);
//   router.post(  '/payouts/bulk-process',     fetchUser, isAdmin, checkPermission('manage_payouts'), payout.bulkProcessPayouts);
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const mongoose        = require('mongoose');
const rn              = require('../services/rewardNotificationService');
const User            = require('../models/User');
const RewardClaim     = require('../models/RewardClaim');
const { writeAudit }  = require('../middleware/rbac');
const Payout          = require('../models/PayoutSchema');
// Tier calculation utilities — the exact same functions activity.js uses when
// the user originally claims a reward, so slab resolution is always consistent.
const { calculatePostsReward }    = require('../utils/calculatePostsReward');
const { calculateReferralReward } = require('../utils/calculateReferralReward');
const { calculateStreakReward }   = require('../utils/calculateStreakReward');

const { getUserPlan } = require('../utils/getPlanKey');
// ═════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Derive the plan key ('2500' | '3500' | '4500') from a User document.
 * Identical logic to planKeyFromUser() in activity.js, earnedRewardsController.js,
 * and userRewardSlabs.js — kept in sync manually; consider extracting to a shared util.
 */
// function planKeyFromUser(user) {
//   if (user.subscription?.planAmount) return String(user.subscription.planAmount);
//   // Plan name → amount key  (matches PLAN_AMOUNTS in payment.js)
//   const nameMap = {
//     Basic:    '2500',
//     Standard: '3500',
//     Silver:   '3500',
//     Gold:     '4500',
//     Premium:  '4500',
//   };
//   return nameMap[user.subscription?.plan] || '2500';
// }

/**
 * Resolve the reward slab for a given claim using the same tier-calculation
 * utilities that activity.js used when the user originally claimed the reward.
 *
 * milestone encoding (matches activity.js exactly):
 *   post     → numeric string "30"       → Number("30")               = 30
 *   referral → numeric string "10"       → Number("10")               = 10
 *   streak   → "<N>days"    "30days"     → strip "days", Number("30") = 30
 *
 * Returns the slab object from the JSON reward files, or null if not found.
 */
function resolveSlabForClaim(rewardType, planKey, milestone) {
  try {
    if (rewardType === 'post') {
      // postsCount milestones: 30 | 70 | 150 | 300 | 600 | 1000
      return calculatePostsReward(Number(milestone), planKey);
    }
    if (rewardType === 'referral') {
      // referralCount milestones: 3 | 6 | 10 | 11…30
      return calculateReferralReward(Number(milestone), planKey);
    }
    if (rewardType === 'streak') {
      // dailystreak milestones: 30 | 60 | 90 | … | 360
      // milestone is stored as "30days" — strip the suffix
      const days = Number(String(milestone).replace('days', ''));
      return calculateStreakReward(days, planKey);
    }
  } catch (err) {
    console.warn(
      `[financeAndPayout] resolveSlabForClaim failed ` +
      `(type=${rewardType}, plan=${planKey}, milestone=${milestone}):`,
      err.message
    );
  }
  return null;
}

/**
 * Convert a slab object into the structured payout amounts.
 *
 * CASH vs OBJECT reward split:
 *   groceryCoupons  →  cashAmountINR (₹ face value, transferred to user's bank)
 *   shares          →  sharesHeld    (object reward, held — NOT paid as cash)
 *   referralToken   →  referralTokenHeld (object reward, held — NOT paid as cash)
 *
 * Returns:
 *   breakdown        — raw unit counts for all three currencies
 *   cashAmountINR    — the ₹ amount to actually pay out (coupons only)
 *   objectRewardsHeld — { sharesHeld, referralTokenHeld } for audit/display
 *   totalAmountINR   — equals cashAmountINR (kept for backward compatibility)
 */
function slabToPayoutAmounts(slab) {
  if (!slab) {
    return {
      breakdown:         { groceryCoupons: 0, shares: 0, referralToken: 0 },
      cashAmountINR:     0,
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
      totalAmountINR:    0,
    };
  }

  const groceryCoupons = slab.groceryCoupons || 0;
  const shares         = slab.shares         || 0;
  const referralToken  = slab.referralToken  || 0;

  // Only grocery coupons are cash — shares and tokens are object rewards held
  const cashAmountINR = groceryCoupons;

  return {
    breakdown: { groceryCoupons, shares, referralToken },
    cashAmountINR,
    objectRewardsHeld: {
      sharesHeld:        shares,
      referralTokenHeld: referralToken,
    },
    // totalAmountINR kept equal to cashAmountINR for backward compat
    totalAmountINR: cashAmountINR,
  };
}

/**
 * Build a human-readable payout description for notes / audit logs.
 * Clearly separates what is being paid in cash from what is held as objects.
 *
 * e.g. "Referral reward – 10 referrals (Silver/₹3500 plan) |
 *        Cash payout: ₹500 (grocery coupons) |
 *        Held (object rewards): 20 shares, 5 tokens"
 */
function claimDescription(rewardType, milestone, planKey, cashAmountINR, objectRewardsHeld = {}) {
  const planLabel = {
    '2500': 'Basic/₹2500',
    '3500': 'Silver/₹3500',
    '4500': 'Gold/₹4500',
  }[planKey] || planKey;

  let mLabel;
  if (rewardType === 'streak') {
    const days = String(milestone).replace('days', '');
    mLabel = `${days} streak days`;
  } else if (rewardType === 'referral') {
    const n = Number(milestone);
    mLabel = `${n} referral${n !== 1 ? 's' : ''}`;
  } else {
    mLabel = `${milestone} posts`;
  }

  const heldParts = [];
  if (objectRewardsHeld.sharesHeld > 0)        heldParts.push(`${objectRewardsHeld.sharesHeld} shares`);
  if (objectRewardsHeld.referralTokenHeld > 0)  heldParts.push(`${objectRewardsHeld.referralTokenHeld} tokens`);
  const heldStr = heldParts.length > 0
    ? ` | Held (object rewards): ${heldParts.join(', ')}`
    : '';

  return (
    `${rewardType.charAt(0).toUpperCase() + rewardType.slice(1)} reward – ` +
    `${mLabel} (${planLabel} plan) | ` +
    `Cash payout: ₹${cashAmountINR} (grocery coupons only)` +
    heldStr
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/payouts ────────────────────────────────────────────────────
/**
 * Paginated list of all payout records with optional filters.
 *
 * Query params:
 *   page        {number}   default 1
 *   limit       {number}   default 25, max 100
 *   status      {string}   pending | processing | paid | failed | on_hold
 *   rewardType  {string}   post | referral | streak
 *   userId      {string}   filter to a specific user ObjectId
 *   from        {ISO date} createdAt >=
 *   to          {ISO date} createdAt <=
 */
exports.listPayouts = async (req, res) => {
  try {
    const page  = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    const filter = {};

    const VALID_STATUSES = ['pending', 'processing', 'paid', 'failed', 'on_hold'];
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const VALID_TYPES = ['post', 'referral', 'streak'];
    if (req.query.rewardType && VALID_TYPES.includes(req.query.rewardType)) {
      filter.rewardType = req.query.rewardType;
    }

    if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
      filter.user = new mongoose.Types.ObjectId(req.query.userId);
    }

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }

    const [payouts, total] = await Promise.all([
      Payout.find(filter)
        .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails kyc.status trustFlags' })
        .populate({ path: 'rewardClaim', model: RewardClaim, select: 'type milestone claimedAt' })
        .populate({ path: 'processedBy', model: User, select: 'name email' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payout.countDocuments(filter),
    ]);

    return res.json({
      payouts,
      pagination: { page, pages: Math.ceil(total / limit), total, limit },
    });
  } catch (err) {
    console.error('[listPayouts]', err);
    return res.status(500).json({ message: 'Failed to fetch payouts' });
  }
};

// ── GET /api/admin/payouts/summary ───────────────────────────────────────────
/**
 * Aggregated cash INR totals for the financial dashboard.
 * All monetary totals use cashAmountINR (grocery coupons only — the actual
 * cash transferred). Object rewards (shares / tokens) are shown separately.
 *
 * Returns:
 *   summary.totalPaidCashINR       — ₹ cash sum of all paid payouts
 *   summary.totalPendingCashINR    — ₹ cash sum of pending + processing payouts
 *   summary.totalOnHoldCashINR     — ₹ cash sum of on_hold payouts
 *   summary.totalFailedCashINR     — ₹ cash sum of failed payouts
 *   summary.avgPayoutCashINR       — average cash payout for paid records (₹)
 *   summary.countByStatus          — document count per status key
 *   summary.paidByRewardType       — ₹ cash paid broken down by post/referral/streak
 *   summary.paidByPlan             — ₹ cash paid broken down by plan key
 *   summary.totalObjectRewardsHeld — { sharesHeld, referralTokenHeld } across all
 *                                    non-terminal payouts (pending/processing/on_hold)
 *   recentPaid                     — last 5 completed payouts
 */
exports.getPayoutSummary = async (req, res) => {
  try {
    const [statusAgg, typeAgg, planAgg, heldAgg, recentPaid] = await Promise.all([
      // Cash INR and count per lifecycle status (using cashAmountINR)
      Payout.aggregate([
        {
          $group: {
            _id:          '$status',
            cashAmountINR: { $sum: '$cashAmountINR' },
            count:        { $sum: 1 },
          },
        },
      ]),

      // ₹ cash totals per reward type (paid records only)
      Payout.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id:          '$rewardType',
            cashAmountINR: { $sum: '$cashAmountINR' },
            count:        { $sum: 1 },
          },
        },
      ]),

      // ₹ cash totals per plan key (paid records only)
      Payout.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id:          '$planKey',
            cashAmountINR: { $sum: '$cashAmountINR' },
            count:        { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Total object rewards held across all non-terminal payouts
      Payout.aggregate([
        { $match: { status: { $in: ['pending', 'processing', 'on_hold'] } } },
        {
          $group: {
            _id:               null,
            sharesHeld:        { $sum: '$objectRewardsHeld.sharesHeld' },
            referralTokenHeld: { $sum: '$objectRewardsHeld.referralTokenHeld' },
          },
        },
      ]),

      // Last 5 paid payouts for the dashboard feed
      Payout.find({ status: 'paid' })
        .populate('user', 'name email username')
        .sort({ paidAt: -1 })
        .limit(5)
        .lean(),
    ]);

    // Flatten status aggregation into keyed maps
    const byCash       = { pending: 0, processing: 0, paid: 0, failed: 0, on_hold: 0 };
    const countByStatus = { ...byCash };
    let paidCount = 0;

    statusAgg.forEach(s => {
      byCash[s._id]       = s.cashAmountINR;
      countByStatus[s._id] = s.count;
      if (s._id === 'paid') paidCount = s.count;
    });

    // Reward-type breakdown (paid only, cash)
    const paidByRewardType = { post: 0, referral: 0, streak: 0, grocery_redeem: 0 };
    typeAgg.forEach(t => { paidByRewardType[t._id] = t.cashAmountINR; });

    // Plan-key breakdown (paid only, cash) — { '2500': { cashAmountINR, count }, … }
    const paidByPlan = {};
    planAgg.forEach(p => {
      paidByPlan[p._id] = { cashAmountINR: p.cashAmountINR, count: p.count };
    });

    // Object rewards held (pending/processing/on_hold)
    const heldRow = heldAgg[0] || { sharesHeld: 0, referralTokenHeld: 0 };
    const totalObjectRewardsHeld = {
      sharesHeld:        heldRow.sharesHeld        || 0,
      referralTokenHeld: heldRow.referralTokenHeld || 0,
    };

    return res.json({
      summary: {
        // Cash fields — these are the actual bank-transfer amounts
        totalPaidCashINR:    byCash.paid,
        totalPendingCashINR: byCash.pending + byCash.processing,
        totalOnHoldCashINR:  byCash.on_hold,
        totalFailedCashINR:  byCash.failed,
        avgPayoutCashINR:    paidCount > 0 ? Math.round(byCash.paid / paidCount) : 0,
        countByStatus,
        paidByRewardType,
        paidByPlan,
        // Object rewards held (non-cash, informational)
        totalObjectRewardsHeld,
      },
      recentPaid,
    });
  } catch (err) {
    console.error('[getPayoutSummary]', err);
    return res.status(500).json({ message: 'Failed to fetch payout summary' });
  }
};

// ── GET /api/admin/payouts/pending-claims ─────────────────────────────────────
/**
 * Returns RewardClaims that have no corresponding Payout document yet —
 * i.e., claims the user successfully submitted via the activity.js routes
 * (POST /referral, /post-reward, /streak-reward) that haven't been paid out.
 *
 * Each claim is enriched server-side with:
 *   planKey            — user's plan at query time ('2500' | '3500' | '4500')
 *   resolvedSlab       — full slab config object from the reward JSON files
 *   breakdown          — { groceryCoupons, shares, referralToken } (raw units)
 *   estimatedCashINR   — the ₹ that will actually be transferred (coupons only)
 *   estimatedObjectRewardsHeld — { sharesHeld, referralTokenHeld } (non-cash)
 *   hasBankDetails     — whether accountNumber + ifscCode are both on file
 *   kycStatus          — user's current KYC status
 *   rewardsFrozen      — whether trustFlags.rewardsFrozen is set
 *
 * Query params:
 *   page      {number}
 *   limit     {number}   max 100
 *   type      {string}   post | referral | streak
 *   minCashINR {number}  post-filter: only claims with cash value ≥ this amount
 *   bankOnly  {boolean}  post-filter: only users with full bank details
 */
exports.listPendingClaims = async (req, res) => {
  try {
    const page  = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    // All claim IDs that already have a payout record
    const processedClaimIds = await Payout.distinct('rewardClaim', {
      rewardClaim: { $ne: null },
    });

    const claimFilter = { _id: { $nin: processedClaimIds } };
    if (req.query.type && ['post', 'referral', 'streak'].includes(req.query.type)) {
      claimFilter.type = req.query.type;
    }

    const [claims, total] = await Promise.all([
      RewardClaim.find(claimFilter)
        .populate('user', 'name email phone username subscription bankDetails kyc trustFlags')
        .sort({ claimedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RewardClaim.countDocuments(claimFilter),
    ]);

    // Enrich each claim with slab resolution + cash/object reward split
    let enriched = claims.map(claim => {
      const user = claim.user;

      if (!user) {
        return {
          ...claim,
          planKey: null, resolvedSlab: null,
          breakdown: { groceryCoupons: 0, shares: 0, referralToken: 0 },
          estimatedCashINR: 0,
          estimatedObjectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
          hasBankDetails: false,
          kycStatus: 'unknown', rewardsFrozen: false,
          enrichmentError: 'User document not found',
        };
      }

      const planKey = getUserPlan(user);
      const slab    = resolveSlabForClaim(claim.type, planKey, claim.milestone);
      const { breakdown, cashAmountINR, objectRewardsHeld } = slabToPayoutAmounts(slab);

      return {
        ...claim,
        planKey,
        resolvedSlab:   slab,
        breakdown,
        // Cash amount (the only amount that will actually be paid out)
        estimatedCashINR: cashAmountINR,
        // Object rewards that will be held, not paid in cash
        estimatedObjectRewardsHeld: objectRewardsHeld,
        // hasBankDetails: needed for bank transfer
        hasBankDetails: !!(user.bankDetails?.accountNumber && user.bankDetails?.ifscCode),
        kycStatus:      user.kyc?.status ?? 'not_started',
        rewardsFrozen:  !!user.trustFlags?.rewardsFrozen,
      };
    });

    // Post-filters (applied after enrichment since they depend on calculated fields)
    if (req.query.minCashINR) {
      const minCashINR = Number(req.query.minCashINR);
      if (!isNaN(minCashINR)) enriched = enriched.filter(c => c.estimatedCashINR >= minCashINR);
    }
    // Keep backward compat: minINR query param still works as an alias
    if (req.query.minINR && !req.query.minCashINR) {
      const minINR = Number(req.query.minINR);
      if (!isNaN(minINR)) enriched = enriched.filter(c => c.estimatedCashINR >= minINR);
    }
    if (req.query.bankOnly === 'true') {
      enriched = enriched.filter(c => c.hasBankDetails);
    }

    return res.json({
      claims: enriched,
      pagination: { page, pages: Math.ceil(total / limit), total, limit },
    });
  } catch (err) {
    console.error('[listPendingClaims]', err);
    return res.status(500).json({ message: 'Failed to fetch pending claims' });
  }
};

// ── GET /api/admin/payouts/user/:userId ───────────────────────────────────────
/**
 * All payout records for a specific user, with:
 *   - full user profile (name, email, plan, bank details, KYC status, wallet totals)
 *   - all payout documents sorted newest-first
 *   - per-status cash INR aggregation
 *   - per-reward-type cash INR aggregation (paid only)
 *   - lifetime total cash payout value
 *   - total object rewards held across all non-terminal payouts
 */
exports.getUserPayouts = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }

    const [payouts, user] = await Promise.all([
      Payout.find({ user: userId })
        .populate('processedBy', 'name email')
        .sort({ createdAt: -1 })
        .lean(),
      User.findById(userId)
        .select(
          'name email phone username subscription bankDetails ' +
          'kyc.status kyc.verifiedAt trustFlags ' +
          'redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs ' +
          'totalGroceryCoupons totalShares totalReferralToken'
        )
        .lean(),
    ]);

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Aggregate totals from payout documents (all cash-based using cashAmountINR)
    const totals = {
      // Cash amounts (grocery coupons only — actually transferred)
      lifetimeCash: 0,
      paidCash:     0,
      pendingCash:  0,  // includes 'processing'
      failedCash:   0,
      onHoldCash:   0,
      byType:       { post: 0, referral: 0, streak: 0, grocery_redeem: 0 },

      // Object rewards held across non-terminal payouts
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
    };

    payouts.forEach(p => {
      const cash = p.cashAmountINR ?? p.totalAmountINR ?? 0; // graceful fallback for older docs
      totals.lifetimeCash += cash;
      if (p.status === 'paid')                                    totals.paidCash    += cash;
      if (p.status === 'pending' || p.status === 'processing')    totals.pendingCash += cash;
      if (p.status === 'failed')                                  totals.failedCash  += cash;
      if (p.status === 'on_hold')                                 totals.onHoldCash  += cash;
      if (p.status === 'paid' && totals.byType[p.rewardType] !== undefined) {
        totals.byType[p.rewardType] += cash;
      }

      // Accumulate held object rewards (non-terminal payouts)
      if (['pending', 'processing', 'on_hold'].includes(p.status)) {
        totals.objectRewardsHeld.sharesHeld        += p.objectRewardsHeld?.sharesHeld        || 0;
        totals.objectRewardsHeld.referralTokenHeld += p.objectRewardsHeld?.referralTokenHeld || 0;
      }
    });

    return res.json({
      user: { ...user, planKey: getUserPlan(user) },
      payouts,
      totals,
    });
  } catch (err) {
    console.error('[getUserPayouts]', err);
    return res.status(500).json({ message: 'Failed to fetch user payouts' });
  }
};

// ── POST /api/admin/payouts/process ───────────────────────────────────────────
/**
 * Create a payout for a single RewardClaim.
 *
 * Cash payout behaviour:
 *   • Only the groceryCoupons value from the slab is paid out in cash.
 *   • Shares and referralTokens are recorded in objectRewardsHeld for
 *     future processing — they do NOT contribute to cashAmountINR.
 *   • If the slab has zero grocery coupons (shares/tokens only), the
 *     payout document is still created but with cashAmountINR = 0 and
 *     status forced to 'on_hold' so admins can review before any bank
 *     transfer is attempted.
 *
 * Steps:
 *   1. Validate claimId + requested initial status
 *   2. Fetch the RewardClaim (populated with user)
 *   3. Guard against duplicate payouts (unique index + pre-check)
 *   4. Resolve the slab via the same calculateXxxReward() utils activity.js uses
 *   5. Split slab into cash (coupons) and object rewards (shares/tokens)
 *   6. Snapshot user's bank details at this moment
 *   7. Create the Payout document
 *   8. Write an audit log entry
 *
 * Body:
 *   claimId        {string}  required — RewardClaim._id
 *   status         {string}  'pending' | 'processing' | 'paid'  (default: 'processing')
 *   transactionRef {string}  optional — external reference (Razorpay / NEFT UTR / IMPS)
 *   notes          {string}  optional — admin note (auto-generated if omitted)
 */
exports.processPayout = async (req, res) => {
  const {
    claimId,
    status: requestedStatus = 'processing',
    transactionRef = null,
    notes = '',
  } = req.body;

  if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
    return res.status(400).json({ message: 'A valid claimId is required' });
  }

  const ALLOWED_INITIAL = ['pending', 'processing', 'paid'];
  if (!ALLOWED_INITIAL.includes(requestedStatus)) {
    return res.status(400).json({
      message: `status must be one of: ${ALLOWED_INITIAL.join(', ')}`,
    });
  }

  try {
    // ── 1. Fetch RewardClaim ───────────────────────────────────────────────────
    const claim = await RewardClaim.findById(claimId)
      .populate('user', 'name email phone username subscription bankDetails kyc trustFlags')
      .lean();

    if (!claim) return res.status(404).json({ message: 'RewardClaim not found' });

    // ── 2. Duplicate guard (pre-check before DB write) ────────────────────────
    const existingPayout = await Payout.findOne({ rewardClaim: claimId });
    if (existingPayout) {
      return res.status(409).json({
        message:  'A payout already exists for this claim',
        payoutId: existingPayout._id,
        status:   existingPayout.status,
      });
    }

    const user = claim.user;
    if (!user) {
      return res.status(404).json({ message: 'User associated with this claim was not found' });
    }

    // ── 3. Slab resolution ────────────────────────────────────────────────────
    const planKey = getUserPlan(user);
    const slab    = resolveSlabForClaim(claim.type, planKey, claim.milestone);

    if (!slab) {
      return res.status(422).json({
        message:
          `Could not resolve reward slab — ` +
          `type="${claim.type}", planKey="${planKey}", milestone="${claim.milestone}". ` +
          `Verify that the reward JSON files contain this combination.`,
        debug: { rewardType: claim.type, planKey, milestone: claim.milestone },
      });
    }

    // ── 4. Cash / object reward split ─────────────────────────────────────────
    const { breakdown, cashAmountINR, objectRewardsHeld, totalAmountINR } =
      slabToPayoutAmounts(slab);

    // If there are zero grocery coupons, this claim has no cash component.
    // We still create the payout document (so the claim is "processed" and
    // the object rewards are visible to admins) but force it to on_hold so
    // no bank transfer can accidentally be triggered.
    const effectiveStatus =
      cashAmountINR === 0 && requestedStatus !== 'pending'
        ? 'on_hold'
        : requestedStatus;

    const hasObjectRewards =
      objectRewardsHeld.sharesHeld > 0 || objectRewardsHeld.referralTokenHeld > 0;

    // ── 5. Bank snapshot ───────────────────────────────────────────────────────
    const bankSnapshot = {
      accountNumber: user.bankDetails?.accountNumber || null,
      ifscCode:      user.bankDetails?.ifscCode      || null,
      panNumber:     user.bankDetails?.panNumber      || null,
    };

    // ── 6. Create Payout ───────────────────────────────────────────────────────
    const now = new Date();
    const payout = await Payout.create({
      user:           user._id,
      rewardClaim:    claim._id,
      rewardType:     claim.type,
      milestone:      claim.milestone,
      planKey,
      breakdown,
      cashAmountINR,
      objectRewardsHeld,
      totalAmountINR,  // equals cashAmountINR (legacy field)
      bankDetails:     bankSnapshot,
      status:          effectiveStatus,
      transactionRef:  transactionRef || null,
      notes: notes || claimDescription(
        claim.type, claim.milestone, planKey, cashAmountINR, objectRewardsHeld
      ),
      processedBy: req.user.id,
      processedAt: now,
      paidAt:      effectiveStatus === 'paid' ? now : null,
    });

    // ── 7. Notify user of the status change ───────────────────────────────────
    setImmediate(() => {
      rn.notifyPayoutStatusChanged({
        payoutId:   String(payout._id),
        userId:     user._id,
        userName:   user.name || user.username,
        oldStatus:  'pending',
        newStatus:  effectiveStatus,
        amountINR:  cashAmountINR,         // only the cash amount in the notification
        rewardType: claim.type,
        milestone:  String(claim.milestone),
        adminName:  req.user.name || req.user.email || 'Admin',
      }).catch(err => console.warn('[notify]', err.message));
    });

    // ── 8. Audit log ───────────────────────────────────────────────────────────
    await writeAudit(req, 'payout_processed', {
      payoutId:          payout._id,
      targetId:          user._id,
      targetEmail:       user.email,
      rewardType:        claim.type,
      milestone:         claim.milestone,
      planKey,
      cashAmountINR,
      objectRewardsHeld,
      status:            effectiveStatus,
      transactionRef:    transactionRef || null,
    });

    // Build response message that clearly explains what happened
    let responseMessage =
      cashAmountINR > 0
        ? `Payout of ₹${cashAmountINR} (grocery coupons) created (status: ${effectiveStatus})`
        : `Payout created with ₹0 cash — no grocery coupons in this slab (status: ${effectiveStatus})`;

    if (hasObjectRewards) {
      const held = [];
      if (objectRewardsHeld.sharesHeld > 0)
        held.push(`${objectRewardsHeld.sharesHeld} shares`);
      if (objectRewardsHeld.referralTokenHeld > 0)
        held.push(`${objectRewardsHeld.referralTokenHeld} tokens`);
      responseMessage += `. Object rewards held (not paid): ${held.join(', ')}.`;
    }

    if (cashAmountINR === 0 && effectiveStatus === 'on_hold') {
      responseMessage +=
        ' Payout set to on_hold because there is no cash component — review manually.';
    }

    return res.status(201).json({
      message:           responseMessage,
      payout,
      cashAmountINR,
      objectRewardsHeld,
      breakdown,
    });
  } catch (err) {
    // Unique index fires if a concurrent request created the payout between our
    // pre-check and the Payout.create() call — return 409 gracefully.
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Payout for this claim already exists (race condition caught)' });
    }
    console.error('[processPayout]', err);
    return res.status(500).json({ message: 'Failed to process payout' });
  }
};

// ── PATCH /api/admin/payouts/:payoutId/status ─────────────────────────────────
/**
 * Transition a payout's status through the defined lifecycle.
 *
 * Allowed transitions:
 *   pending    → processing | paid | on_hold | failed
 *   processing → paid | failed | on_hold
 *   failed     → pending                            (retry)
 *   on_hold    → pending                            (resume)
 *   paid       → (terminal — no further transitions allowed)
 *
 * Body:
 *   status          {string}  required
 *   transactionRef  {string}  recommended when transitioning to 'paid'
 *   failureReason   {string}  required when transitioning to 'failed'
 *   notes           {string}  optional
 */
exports.updatePayoutStatus = async (req, res) => {
  const { payoutId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(payoutId)) {
    return res.status(400).json({ message: 'Invalid payoutId' });
  }

  const { status: newStatus, transactionRef, failureReason, notes } = req.body;

  if (!newStatus) {
    return res.status(400).json({ message: 'status is required' });
  }
  if (newStatus === 'failed' && !failureReason) {
    return res.status(400).json({
      message: 'failureReason is required when marking a payout as failed',
    });
  }

  // Valid next-states per current state
  const TRANSITIONS = {
    pending:    ['processing', 'paid', 'on_hold', 'failed'],
    processing: ['paid', 'failed', 'on_hold'],
    failed:     ['pending'],
    on_hold:    ['pending'],
    paid:       [],  // terminal
  };

  try {
    const payout = await Payout.findById(payoutId);
    if (!payout) return res.status(404).json({ message: 'Payout not found' });

    const allowed = TRANSITIONS[payout.status];

    if (payout.status === 'paid') {
      return res.status(409).json({
        message: 'This payout has already been paid — it cannot be transitioned further.',
        currentStatus: payout.status,
      });
    }

    if (!allowed.includes(newStatus)) {
      return res.status(409).json({
        message:             `Cannot transition "${payout.status}" → "${newStatus}".`,
        currentStatus:       payout.status,
        allowedNextStatuses: allowed,
      });
    }

    // Guard: attempting to pay a ₹0 cash payout is almost certainly a mistake.
    // Force admin to set on_hold / failed instead of paid if cashAmountINR is 0.
    if (newStatus === 'paid' && (payout.cashAmountINR ?? payout.totalAmountINR ?? 0) === 0) {
      return res.status(422).json({
        message:
          'Cannot mark this payout as paid — cashAmountINR is ₹0 (no grocery coupons). ' +
          'Object rewards (shares/tokens) are not paid as cash. Use on_hold or failed instead.',
        cashAmountINR:     payout.cashAmountINR,
        objectRewardsHeld: payout.objectRewardsHeld,
      });
    }

    const previousStatus = payout.status;
    const now            = new Date();

    payout.status      = newStatus;
    payout.processedBy = req.user.id;
    payout.processedAt = now;

    if (transactionRef) payout.transactionRef = transactionRef;
    if (notes)          payout.notes          = notes;

    if (newStatus === 'paid') {
      payout.paidAt        = now;
      payout.failureReason = null;   // clear any previous failure message
    }
    if (newStatus === 'failed') {
      payout.failureReason = failureReason;
    }
    if (newStatus === 'pending') {
      // Resetting for retry (from failed) or resume (from on_hold)
      payout.failureReason = null;
    }

    await payout.save();

    if (newStatus === 'paid' && payout.rewardType === 'grocery_redeem') {
      await User.findByIdAndUpdate(payout.user, {
        $inc: { totalGroceryCoupons: -(payout.totalAmountINR || 0) }
      });
      // Floor at 0 to guard against race conditions:
      await User.updateOne(
        { _id: payout.user, totalGroceryCoupons: { $lt: 0 } },
        { $set: { totalGroceryCoupons: 0 } }
      );
    }

    setImmediate(() => {
      rn.notifyPayoutStatusChanged({
        payoutId:       String(payout._id),
        userId:         payout.user?._id ?? payout.user,
        userName:       payout.user?.name || 'User',
        oldStatus:      previousStatus,
        newStatus,
        amountINR:      payout.cashAmountINR ?? payout.totalAmountINR ?? 0,
        rewardType:     payout.rewardType,
        milestone:      String(payout.milestone),
        transactionRef: transactionRef || null,
        failureReason:  failureReason  || null,
        adminName:      req.user.name  || req.user.email || 'Admin',
      }).catch(err => console.warn('[notify]', err.message));
    });

    await writeAudit(req, 'payout_status_updated', {
      payoutId:          payout._id,
      targetId:          payout.user,
      previousStatus,
      newStatus,
      cashAmountINR:     payout.cashAmountINR,
      objectRewardsHeld: payout.objectRewardsHeld,
      transactionRef:    transactionRef || null,
      failureReason:     failureReason  || null,
    });

    return res.json({
      message: `Payout updated: ${previousStatus} → ${newStatus}`,
      payout,
    });
  } catch (err) {
    console.error('[updatePayoutStatus]', err);
    return res.status(500).json({ message: 'Failed to update payout status' });
  }
};

// ── POST /api/admin/payouts/bulk-process ──────────────────────────────────────
/**
 * Process payouts for up to 100 RewardClaims in a single admin request.
 * Designed for end-of-month batch payout runs from the admin panel.
 *
 * Cash payout behaviour (same as processPayout):
 *   • Only groceryCoupons from each slab are paid as cash.
 *   • Shares and tokens are recorded in objectRewardsHeld — never transferred.
 *   • Claims where cashAmountINR === 0 are created with status 'on_hold'
 *     so they appear in the admin panel for manual review.
 *
 * Processing is sequential (not Promise.all) to avoid write pressure on MongoDB
 * and to report per-claim results accurately. Partial success is intentional —
 * the full results breakdown tells the admin exactly what happened to each claim.
 *
 * Body:
 *   claimIds  {string[]}  required — array of RewardClaim._id values (max 100)
 *   status    {string}    'processing' | 'paid'  (default: 'processing')
 *   notes     {string}    optional — applied to all created payouts in this batch
 *
 * Response (HTTP 207 Multi-Status):
 *   processed              — claims where a new Payout was successfully created
 *   skipped                — claims that already had a Payout (idempotent, not an error)
 *   failed                 — claims that could not be processed, with reasons
 *   totalCashINRDispatched — ₹ grocery coupon sum for all successfully processed payouts
 *   totalObjectRewardsHeld — { sharesHeld, referralTokenHeld } across all processed payouts
 */
exports.bulkProcessPayouts = async (req, res) => {
  const { claimIds, status: requestedStatus = 'processing', notes = '' } = req.body;

  if (!Array.isArray(claimIds) || claimIds.length === 0) {
    return res.status(400).json({ message: 'claimIds must be a non-empty array' });
  }
  if (claimIds.length > 100) {
    return res.status(400).json({ message: 'Maximum 100 claims per bulk request' });
  }
  if (!['processing', 'paid'].includes(requestedStatus)) {
    return res.status(400).json({ message: "status must be 'processing' or 'paid'" });
  }

  // Validate all IDs upfront — fail fast before touching the DB
  const invalidIds = claimIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
  if (invalidIds.length > 0) {
    return res.status(400).json({
      message: `${invalidIds.length} invalid ObjectId(s) in claimIds`,
      invalidIds,
    });
  }

  const results = {
    processed: [],  // { claimId, payoutId, rewardType, milestone, planKey, cashAmountINR, objectRewardsHeld, status, userEmail }
    skipped:   [],  // { claimId, payoutId, status, reason }
    failed:    [],  // { claimId, reason }
  };

  const now = new Date();

  for (const claimId of claimIds) {
    try {
      // ── Duplicate guard ────────────────────────────────────────────────────
      const existing = await Payout.findOne({ rewardClaim: claimId });
      if (existing) {
        results.skipped.push({
          claimId,
          payoutId: existing._id,
          status:   existing.status,
          reason:   'Payout already exists',
        });
        continue;
      }

      // ── Fetch claim + populated user ───────────────────────────────────────
      const claim = await RewardClaim.findById(claimId)
        .populate('user', 'name email phone username subscription bankDetails kyc trustFlags')
        .lean();

      if (!claim) {
        results.failed.push({ claimId, reason: 'RewardClaim not found' });
        continue;
      }
      if (!claim.user) {
        results.failed.push({ claimId, reason: 'User associated with claim not found' });
        continue;
      }

      // ── Slab resolution → cash/object split ───────────────────────────────
      const planKey = getUserPlan(claim.user);
      const slab    = resolveSlabForClaim(claim.type, planKey, claim.milestone);

      if (!slab) {
        results.failed.push({
          claimId,
          reason: `Slab not found (type=${claim.type}, plan=${planKey}, milestone=${claim.milestone})`,
        });
        continue;
      }

      const { breakdown, cashAmountINR, objectRewardsHeld, totalAmountINR } =
        slabToPayoutAmounts(slab);

      // Claims with zero cash (object-reward-only slabs) go to on_hold
      // instead of the requested status — no cash to transfer.
      const effectiveStatus =
        cashAmountINR === 0 && requestedStatus !== 'pending'
          ? 'on_hold'
          : requestedStatus;

      // ── Create Payout ──────────────────────────────────────────────────────
      const payout = await Payout.create({
        user:           claim.user._id,
        rewardClaim:    claim._id,
        rewardType:     claim.type,
        milestone:      claim.milestone,
        planKey,
        breakdown,
        cashAmountINR,
        objectRewardsHeld,
        totalAmountINR,  // equals cashAmountINR (legacy field)
        bankDetails: {
          accountNumber: claim.user.bankDetails?.accountNumber || null,
          ifscCode:      claim.user.bankDetails?.ifscCode      || null,
          panNumber:     claim.user.bankDetails?.panNumber     || null,
        },
        status:      effectiveStatus,
        notes: notes || claimDescription(
          claim.type, claim.milestone, planKey, cashAmountINR, objectRewardsHeld
        ),
        processedBy: req.user.id,
        processedAt: now,
        paidAt:      effectiveStatus === 'paid' ? now : null,
      });

      results.processed.push({
        claimId,
        payoutId:          payout._id,
        rewardType:        claim.type,
        milestone:         claim.milestone,
        planKey,
        cashAmountINR,
        objectRewardsHeld,
        status:            effectiveStatus,
        userEmail:         claim.user.email,
        // Informational: was this forced to on_hold because of zero cash?
        forcedToOnHold:    effectiveStatus === 'on_hold' && requestedStatus !== 'on_hold',
      });

      // Notify user of payout creation (fire-and-forget)
      setImmediate(() => {
        rn.notifyPayoutStatusChanged({
          payoutId:   String(payout._id),
          userId:     claim.user._id,
          userName:   claim.user.name || claim.user.username,
          oldStatus:  'pending',
          newStatus:  effectiveStatus,
          amountINR:  cashAmountINR,         // only the cash amount in the notification
          rewardType: claim.type,
          milestone:  String(claim.milestone),
          adminName:  req.user.name || req.user.email || 'Admin',
        }).catch(err => console.warn('[notify]', err.message));
      });

    } catch (err) {
      if (err.code === 11000) {
        // Unique index fired — concurrent request created the payout between our
        // pre-check and create() — treat as skipped, not failed
        results.skipped.push({ claimId, reason: 'Duplicate payout (race condition caught)' });
      } else {
        console.error(`[bulkProcessPayouts] claimId=${claimId}:`, err.message);
        results.failed.push({ claimId, reason: err.message });
      }
    }
  }

  // Accumulate batch-level totals from results
  const totalCashINRDispatched = results.processed.reduce(
    (s, p) => s + (p.cashAmountINR || 0), 0
  );
  const totalObjectRewardsHeld = results.processed.reduce(
    (acc, p) => {
      acc.sharesHeld        += p.objectRewardsHeld?.sharesHeld        || 0;
      acc.referralTokenHeld += p.objectRewardsHeld?.referralTokenHeld || 0;
      return acc;
    },
    { sharesHeld: 0, referralTokenHeld: 0 }
  );
  const forcedToOnHoldCount = results.processed.filter(p => p.forcedToOnHold).length;

  // Notify admins of bulk completion (fire-and-forget)
  setImmediate(() => {
    rn.notifyBulkPayoutComplete({
      adminId:                req.user.id,
      adminName:              req.user.name || req.user.email || 'Admin',
      processed:              results.processed.length,
      skipped:                results.skipped.length,
      failed:                 results.failed.length,
      totalCashINRDispatched,
      totalObjectRewardsHeld,
      forcedToOnHoldCount,
    }).catch(err => console.warn('[notify]', err.message));
  });

  // Single audit entry for the entire batch
  await writeAudit(req, 'payout_bulk_processed', {
    processedCount:         results.processed.length,
    skippedCount:           results.skipped.length,
    failedCount:            results.failed.length,
    totalCashINRDispatched,
    totalObjectRewardsHeld,
    forcedToOnHoldCount,
    requestedStatus,
  }).catch(() => {}); // audit failure must never break the response

  return res.status(207).json({
    message:
      `Bulk complete — ${results.processed.length} processed, ` +
      `${results.skipped.length} skipped, ${results.failed.length} failed` +
      (forcedToOnHoldCount > 0
        ? ` (${forcedToOnHoldCount} forced to on_hold — zero cash component)`
        : ''),
    totalCashINRDispatched,
    totalObjectRewardsHeld,
    results,
  });
};

/*----- GET /api/admin/payouts/unredeemed-wallets ------*/
exports.listUnredeemedWallets = async (req, res) => {
  try {
    const page  = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;
 
    // ── Step 1: find users who already have an active redemption in flight ──
    // These users HAVE redeemed; exclude them from the "hasn't redeemed" list.
    const activeRedemptionUserIds = await Payout.distinct('user', {
      rewardType: 'grocery_redeem',
      status:     { $in: ['pending', 'processing', 'on_hold'] },
    });
 
    // ── Step 2: build the User query ────────────────────────────────────────
    const minBalance = Math.max(0, parseFloat(req.query.minBalance) || 1);
 
    const userFilter = {
      // Must have a positive coupon balance above the threshold
      totalGroceryCoupons: { $gte: minBalance },
      // Must NOT have an active redemption already in flight
      _id: { $nin: activeRedemptionUserIds },
      // Only regular users (not admins)
      role: { $in: ['user', null] },
    };
 
    // Optional: filter by KYC status
    if (req.query.kycStatus) {
      userFilter['kyc.status'] = req.query.kycStatus;
    }
 
    // Optional: only users with full bank details on file
    if (req.query.bankOnly === 'true') {
      userFilter['bankDetails.accountNumber'] = { $exists: true, $ne: null, $ne: '' };
      userFilter['bankDetails.ifscCode']      = { $exists: true, $ne: null, $ne: '' };
    }
 
    // Optional: partial search on name or email
    if (req.query.search) {
      const rx = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      userFilter.$or = [
        { name:  rx },
        { email: rx },
        { username: rx },
      ];
    }
 
    const [users, total] = await Promise.all([
      User.find(userFilter)
        .select(
          'name email phone username ' +
          'totalGroceryCoupons totalShares totalReferralToken ' +
          'subscription kyc bankDetails trustFlags ' +
          'redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs ' +
          'lastActive'
        )
        .sort({ totalGroceryCoupons: -1 })   // highest balance first
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(userFilter),
    ]);
 
    // ── Step 3: enrich each user with readiness indicators ──────────────────
    const enriched = users.map(u => {
      const hasBankDetails = !!(
        u.bankDetails?.accountNumber && u.bankDetails?.ifscCode
      );
      const kycStatus      = u.kyc?.status ?? 'not_started';
      const kycVerified    = kycStatus === 'verified';
      const subActive      = !!u.subscription?.active;
      const subExpired     = subActive && u.subscription?.expiresAt
        && new Date(u.subscription.expiresAt) < new Date();
      const eligible       = kycVerified && subActive && !subExpired &&
        !u.trustFlags?.rewardsFrozen;
 
      // Count total slabs redeemed — helps admin understand how active this user is
      const totalSlabsRedeemed =
        (u.redeemedPostSlabs?.length     || 0) +
        (u.redeemedReferralSlabs?.length || 0) +
        (u.redeemedStreakSlabs?.length   || 0);
 
      return {
        _id:                  u._id,
        name:                 u.name,
        email:                u.email,
        phone:                u.phone,
        username:             u.username,
        // Wallet
        totalGroceryCoupons:  u.totalGroceryCoupons || 0,
        totalShares:          u.totalShares || 0,
        totalReferralToken:   u.totalReferralToken || 0,
        // Subscription
        plan:                 u.subscription?.plan     || null,
        planKey:              getUserPlan(u),
        subActive,
        subExpired:           !!subExpired,
        // KYC
        kycStatus,
        kycVerified,
        // Bank
        hasBankDetails,
        bankAccountMasked:    u.bankDetails?.accountNumber
          ? `****${String(u.bankDetails.accountNumber).slice(-4)}`
          : null,
        // Trust
        rewardsFrozen:        !!u.trustFlags?.rewardsFrozen,
        // Composite eligibility flag — user can self-redeem right now
        eligible,
        // Engagement summary
        totalSlabsRedeemed,
        lastActive:           u.lastActive ?? null,
      };
    });
 
    // ── Step 4: aggregate summary totals for the KPI bar ────────────────────
    // Run a separate aggregate for the full dataset (not just this page)
    const totalsAgg = await User.aggregate([
      { $match: {
          totalGroceryCoupons: { $gte: minBalance },
          _id: { $nin: activeRedemptionUserIds },
          role: { $in: ['user', null] },
      }},
      { $group: {
          _id:           null,
          totalBalance:  { $sum: '$totalGroceryCoupons' },
          eligibleCount: { $sum: {
            $cond: [
              { $and: [
                { $eq:  ['$kyc.status', 'verified'] },
                { $eq:  ['$subscription.active', true] },
                { $ne:  ['$trustFlags.rewardsFrozen', true] },
              ]},
              1, 0,
            ],
          }},
          noBankCount: { $sum: {
            $cond: [
              { $or: [
                { $not: ['$bankDetails.accountNumber'] },
                { $eq:  ['$bankDetails.accountNumber', null] },
              ]},
              1, 0,
            ],
          }},
      }},
    ]);
 
    const summaryTotals = totalsAgg[0] || {
      totalBalance: 0, eligibleCount: 0, noBankCount: 0,
    };
 
    return res.json({
      users:      enriched,
      pagination: { page, pages: Math.ceil(total / limit), total, limit },
      summary: {
        totalUsersWithBalance: total,
        totalUnredeemedINR:    summaryTotals.totalBalance  || 0,
        eligibleToRedeem:      summaryTotals.eligibleCount || 0,
        missingBankDetails:    summaryTotals.noBankCount   || 0,
      },
    });
  } catch (err) {
    console.error('[listUnredeemedWallets]', err);
    return res.status(500).json({ message: 'Failed to fetch unredeemed wallets' });
  }
};

// ── Export the Payout model so adminRoutes.js or tests can import it ──────────
exports.Payout = Payout;