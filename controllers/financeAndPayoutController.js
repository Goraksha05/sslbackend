// controllers/financeAndPayoutController.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin payout management for the three user activity reward types:
//   • post     — milestone slabs: 30 / 70 / 150 / 300 / 600 / 1000 posts
//   • referral — milestone slabs: 3 / 6 / 10 (big) + 11–30 (token-only)
//   • streak   — milestone slabs: 30 / 60 / 90 / … / 360 days
//
// Reward currency → INR conversion (all amounts in ₹):
//   groceryCoupons  → face value  (₹1 = ₹1)
//   shares          → ₹1 per unit (SHARE_INR_VALUE)
//   referralToken   → ₹1 per token (TOKEN_INR_VALUE)
//
// RewardClaim.milestone encoding (mirrors activity.js exactly):
//   post     → String(number)   e.g. "30", "300"
//   referral → String(number)   e.g. "3", "10"
//   streak   → "<N>days"        e.g. "30days", "360days"
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

const mongoose    = require('mongoose');
const User        = require('../models/User');
const RewardClaim = require('../models/RewardClaim');
const { writeAudit } = require('../middleware/rbac');
const Payout = require('../models/PayoutSchema');
// Tier calculation utilities — the exact same functions activity.js uses when
// the user originally claims a reward, so slab resolution is always consistent.
const { calculatePostsReward }    = require('../utils/calculatePostsReward');
const { calculateReferralReward } = require('../utils/calculateReferralReward');
const { calculateStreakReward }   = require('../utils/calculateStreakReward');

// ── INR conversion rates ───────────────────────────────────────────────────────
// Adjust these two constants when valuations change — nothing else needs updating.
const SHARE_INR_VALUE = 1;  // 1 share unit   = ₹1
const TOKEN_INR_VALUE = 1;  // 1 referralToken = ₹1

// ═════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Derive the plan key ('2500' | '3500' | '4500') from a User document.
 * Identical logic to planKeyFromUser() in activity.js, earnedRewardsController.js,
 * and userRewardSlabs.js — kept in sync manually; consider extracting to a shared util.
 */
function planKeyFromUser(user) {
  if (user.subscription?.planAmount) return String(user.subscription.planAmount);
  // Plan name → amount key  (matches PLAN_AMOUNTS in payment.js)
  const nameMap = {
    Basic:    '2500',
    Standard: '3500',
    Silver:   '3500',
    Gold:     '4500',
    Premium:  '4500',
  };
  return nameMap[user.subscription?.plan] || '2500';
}

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
 * Convert a slab object to a structured ₹ breakdown + total.
 *
 * Currency → INR:
 *   groceryCoupons  → ₹ face value  (no conversion needed)
 *   shares          → units × SHARE_INR_VALUE
 *   referralToken   → tokens × TOKEN_INR_VALUE
 */
function slabToINR(slab) {
  if (!slab) {
    return { breakdown: { groceryCoupons: 0, shares: 0, referralToken: 0 }, totalAmountINR: 0 };
  }

  const groceryCoupons = slab.groceryCoupons || 0;
  const shares         = slab.shares         || 0;
  const referralToken  = slab.referralToken  || 0;

  const totalAmountINR =
    groceryCoupons +
    shares        * SHARE_INR_VALUE +
    referralToken * TOKEN_INR_VALUE;

  return {
    breakdown: { groceryCoupons, shares, referralToken },
    totalAmountINR,
  };
}

/**
 * Build a human-readable payout description for notes / audit logs.
 * e.g. "Referral reward – 10 referrals (Silver/₹3500 plan) → ₹3,760"
 */
function claimDescription(rewardType, milestone, planKey, totalAmountINR) {
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

  return `${rewardType.charAt(0).toUpperCase() + rewardType.slice(1)} reward – ${mLabel} (${planLabel} plan) → ₹${totalAmountINR}`;
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
        .populate('user',        'name email phone username subscription bankDetails kyc.status trustFlags')
        .populate('rewardClaim', 'type milestone claimedAt')
        .populate('processedBy', 'name email')
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
 * Aggregated INR totals for the financial dashboard.
 *
 * Returns:
 *   summary.totalPaidINR         — ₹ sum of all paid payouts
 *   summary.totalPendingINR      — ₹ sum of pending + processing payouts
 *   summary.totalOnHoldINR       — ₹ sum of on_hold payouts
 *   summary.totalFailedINR       — ₹ sum of failed payouts
 *   summary.avgPayoutINR         — average payout for paid records (₹)
 *   summary.countByStatus        — document count per status key
 *   summary.paidByRewardType     — ₹ paid broken down by post/referral/streak
 *   summary.paidByPlan           — ₹ paid broken down by plan key
 *   recentPaid                   — last 5 completed payouts
 */
exports.getPayoutSummary = async (req, res) => {
  try {
    const [statusAgg, typeAgg, planAgg, recentPaid] = await Promise.all([
      // Total INR and count per lifecycle status
      Payout.aggregate([
        {
          $group: {
            _id:            '$status',
            totalAmountINR: { $sum: '$totalAmountINR' },
            count:          { $sum: 1 },
          },
        },
      ]),

      // ₹ totals per reward type (paid records only)
      Payout.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id:            '$rewardType',
            totalAmountINR: { $sum: '$totalAmountINR' },
            count:          { $sum: 1 },
          },
        },
      ]),

      // ₹ totals per plan key (paid records only)
      Payout.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id:            '$planKey',
            totalAmountINR: { $sum: '$totalAmountINR' },
            count:          { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Last 5 paid payouts for the dashboard feed
      Payout.find({ status: 'paid' })
        .populate('user', 'name email username')
        .sort({ paidAt: -1 })
        .limit(5)
        .lean(),
    ]);

    // Flatten status aggregation into keyed maps
    const byStatus      = { pending: 0, processing: 0, paid: 0, failed: 0, on_hold: 0 };
    const countByStatus = { ...byStatus };
    let paidCount = 0;

    statusAgg.forEach(s => {
      byStatus[s._id]      = s.totalAmountINR;
      countByStatus[s._id] = s.count;
      if (s._id === 'paid') paidCount = s.count;
    });

    // Reward-type breakdown (paid only)
    const paidByRewardType = { post: 0, referral: 0, streak: 0 };
    typeAgg.forEach(t => { paidByRewardType[t._id] = t.totalAmountINR; });

    // Plan-key breakdown (paid only) — { '2500': { totalAmountINR, count }, … }
    const paidByPlan = {};
    planAgg.forEach(p => {
      paidByPlan[p._id] = { totalAmountINR: p.totalAmountINR, count: p.count };
    });

    return res.json({
      summary: {
        totalPaidINR:      byStatus.paid,
        totalPendingINR:   byStatus.pending + byStatus.processing,
        totalOnHoldINR:    byStatus.on_hold,
        totalFailedINR:    byStatus.failed,
        avgPayoutINR:      paidCount > 0 ? Math.round(byStatus.paid / paidCount) : 0,
        countByStatus,
        paidByRewardType,
        paidByPlan,
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
 *   planKey        — user's plan at query time ('2500' | '3500' | '4500')
 *   resolvedSlab   — full slab config object from the reward JSON files
 *   breakdown      — { groceryCoupons, shares, referralToken } in ₹
 *   estimatedINR   — total payout amount the user is owed
 *   hasBankDetails — whether accountNumber + ifscCode are both on file
 *   kycStatus      — user's current KYC status
 *   rewardsFrozen  — whether trustFlags.rewardsFrozen is set
 *
 * Query params:
 *   page      {number}
 *   limit     {number}   max 100
 *   type      {string}   post | referral | streak
 *   minINR    {number}   post-filter: only claims worth ≥ this amount
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

    // Enrich each claim with slab resolution + INR calculation
    let enriched = claims.map(claim => {
      const user = claim.user;

      if (!user) {
        return {
          ...claim,
          planKey: null, resolvedSlab: null,
          breakdown: { groceryCoupons: 0, shares: 0, referralToken: 0 },
          estimatedINR: 0, hasBankDetails: false,
          kycStatus: 'unknown', rewardsFrozen: false,
          enrichmentError: 'User document not found',
        };
      }

      const planKey              = planKeyFromUser(user);
      const slab                 = resolveSlabForClaim(claim.type, planKey, claim.milestone);
      const { breakdown, totalAmountINR } = slabToINR(slab);

      return {
        ...claim,
        planKey,
        resolvedSlab:   slab,
        breakdown,
        estimatedINR:   totalAmountINR,
        // hasBankDetails: user must have both accountNumber AND ifscCode — needed for transfer
        hasBankDetails: !!(user.bankDetails?.accountNumber && user.bankDetails?.ifscCode),
        kycStatus:      user.kyc?.status ?? 'not_started',
        rewardsFrozen:  !!user.trustFlags?.rewardsFrozen,
      };
    });

    // Post-filters (applied after enrichment since they depend on calculated fields)
    if (req.query.minINR) {
      const minINR = Number(req.query.minINR);
      if (!isNaN(minINR)) enriched = enriched.filter(c => c.estimatedINR >= minINR);
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
 *   - per-status INR aggregation
 *   - per-reward-type INR aggregation (paid only)
 *   - lifetime total payout value
 *
 * Useful for the user detail drawer / user financial history in the admin panel.
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

    // Aggregate totals from payout documents
    const totals = {
      lifetime: 0,
      paid:     0,
      pending:  0,  // includes 'processing'
      failed:   0,
      on_hold:  0,
      byType:   { post: 0, referral: 0, streak: 0 },
    };

    payouts.forEach(p => {
      const amt = p.totalAmountINR || 0;
      totals.lifetime += amt;
      if (p.status === 'paid')                                    totals.paid    += amt;
      if (p.status === 'pending' || p.status === 'processing')    totals.pending += amt;
      if (p.status === 'failed')                                  totals.failed  += amt;
      if (p.status === 'on_hold')                                 totals.on_hold += amt;
      if (p.status === 'paid' && totals.byType[p.rewardType] !== undefined) {
        totals.byType[p.rewardType] += amt;
      }
    });

    return res.json({
      user: { ...user, planKey: planKeyFromUser(user) },
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
 * Steps:
 *   1. Validate claimId + requested initial status
 *   2. Fetch the RewardClaim (populated with user)
 *   3. Guard against duplicate payouts (unique index + pre-check)
 *   4. Resolve the slab via the same calculateXxxReward() utils activity.js uses
 *   5. Convert slab currencies → ₹ totalAmountINR
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
    const planKey = planKeyFromUser(user);
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

    // ── 4. INR conversion ──────────────────────────────────────────────────────
    const { breakdown, totalAmountINR } = slabToINR(slab);

    if (totalAmountINR <= 0) {
      return res.status(422).json({
        message: 'Slab resolved but total INR is ₹0 — nothing to pay out.',
        slab,
        breakdown,
      });
    }

    // ── 5. Bank snapshot ───────────────────────────────────────────────────────
    const bankSnapshot = {
      accountNumber: user.bankDetails?.accountNumber || null,
      ifscCode:      user.bankDetails?.ifscCode      || null,
      panNumber:     user.bankDetails?.panNumber      || null,
    };

    // ── 6. Create Payout ───────────────────────────────────────────────────────
    const now    = new Date();
    const payout = await Payout.create({
      user:           user._id,
      rewardClaim:    claim._id,
      rewardType:     claim.type,
      milestone:      claim.milestone,
      planKey,
      breakdown,
      totalAmountINR,
      bankSnapshot,
      status:         requestedStatus,
      transactionRef: transactionRef || null,
      // Auto-generate a human-readable note if the admin didn't supply one
      notes: notes || claimDescription(claim.type, claim.milestone, planKey, totalAmountINR),
      processedBy: req.user.id,
      processedAt: now,
      paidAt:      requestedStatus === 'paid' ? now : null,
    });

    // ── 7. Audit log ───────────────────────────────────────────────────────────
    await writeAudit(req, 'payout_processed', {
      payoutId:       payout._id,
      targetId:       user._id,
      targetEmail:    user.email,
      rewardType:     claim.type,
      milestone:      claim.milestone,
      planKey,
      totalAmountINR,
      status:         requestedStatus,
      transactionRef: transactionRef || null,
    });

    return res.status(201).json({
      message:   `Payout of ₹${totalAmountINR} created (status: ${requestedStatus})`,
      payout,
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

    await writeAudit(req, 'payout_status_updated', {
      payoutId:       payout._id,
      targetId:       payout.user,
      previousStatus,
      newStatus,
      transactionRef: transactionRef || null,
      failureReason:  failureReason  || null,
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
 *   processed          — claims where a new Payout was successfully created
 *   skipped            — claims that already had a Payout (idempotent, not an error)
 *   failed             — claims that could not be processed, with reasons
 *   totalINRDispatched — ₹ sum for all successfully processed payouts
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
    processed: [],  // { claimId, payoutId, rewardType, milestone, planKey, totalAmountINR, userEmail }
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

      // ── Slab resolution → INR ──────────────────────────────────────────────
      const planKey = planKeyFromUser(claim.user);
      const slab    = resolveSlabForClaim(claim.type, planKey, claim.milestone);

      if (!slab) {
        results.failed.push({
          claimId,
          reason: `Slab not found (type=${claim.type}, plan=${planKey}, milestone=${claim.milestone})`,
        });
        continue;
      }

      const { breakdown, totalAmountINR } = slabToINR(slab);

      if (totalAmountINR <= 0) {
        results.failed.push({
          claimId,
          reason: 'Slab resolved but total INR is ₹0 — nothing to pay out',
        });
        continue;
      }

      // ── Create Payout ──────────────────────────────────────────────────────
      const payout = await Payout.create({
        user:           claim.user._id,
        rewardClaim:    claim._id,
        rewardType:     claim.type,
        milestone:      claim.milestone,
        planKey,
        breakdown,
        totalAmountINR,
        bankSnapshot: {
          accountNumber: claim.user.bankDetails?.accountNumber || null,
          ifscCode:      claim.user.bankDetails?.ifscCode      || null,
          panNumber:     claim.user.bankDetails?.panNumber      || null,
        },
        status:      requestedStatus,
        notes: notes || claimDescription(claim.type, claim.milestone, planKey, totalAmountINR),
        processedBy: req.user.id,
        processedAt: now,
        paidAt:      requestedStatus === 'paid' ? now : null,
      });

      results.processed.push({
        claimId,
        payoutId:       payout._id,
        rewardType:     claim.type,
        milestone:      claim.milestone,
        planKey,
        totalAmountINR,
        status:         requestedStatus,
        userEmail:      claim.user.email,
      });
    } catch (err) {
      if (err.code === 11000) {
        // Unique index fired — a concurrent request created the payout between our
        // pre-check and create() — treat as skipped, not failed
        results.skipped.push({ claimId, reason: 'Duplicate payout (race condition caught)' });
      } else {
        console.error(`[bulkProcessPayouts] claimId=${claimId}:`, err.message);
        results.failed.push({ claimId, reason: err.message });
      }
    }
  }

  const totalINRDispatched = results.processed.reduce((s, p) => s + (p.totalAmountINR || 0), 0);

  // Single audit entry for the entire batch
  await writeAudit(req, 'payout_bulk_processed', {
    processedCount:     results.processed.length,
    skippedCount:       results.skipped.length,
    failedCount:        results.failed.length,
    totalINRDispatched,
    requestedStatus,
  }).catch(() => {}); // audit failure must never break the response

  return res.status(207).json({
    message: `Bulk complete — ${results.processed.length} processed, ${results.skipped.length} skipped, ${results.failed.length} failed`,
    totalINRDispatched,
    results,
  });
};

// ── Export the Payout model so adminRoutes.js or tests can import it ──────────
exports.Payout = Payout;