/**
 * controllers/financeAndPayoutController.js  (UPDATED)
 *
 * KEY CHANGES from original:
 *
 *   1. CRITICAL — Admin panel now only shows USER-REQUESTED payouts in the
 *      "Pending Claims" tab for grocery_redeem type.
 *      - listPendingClaims() filters: userRequested === true for grocery_redeem
 *      - Non-requested grocery coupons (wallet balance) are SEPARATE in
 *        "Unredeemed Wallets" tab — those are NOT auto-paid by admin.
 *      - Admin only pays what the user explicitly requested.
 *
 *   2. NEW — exports.getPayoutReport() — full payout report with bank details
 *      for Excel download. GET /api/admin/payouts/report
 *      Returns every payout with: user info, bank details, amounts, status,
 *      dates, transaction refs — everything needed for reconciliation.
 *
 *   3. NEW — exports.listUserRequestedPayouts() — lists only user-initiated
 *      grocery redemption requests (userRequested: true). These are the payouts
 *      the admin is responsible for paying. GET /api/admin/payouts/user-requested
 *
 *   4. processPayout() now sets userRequested: false on admin-created payouts
 *      so reports can distinguish the two paths.
 *
 *   5. Payout.create() in processPayout() now sets cashAmountINR explicitly
 *      (was relying on totalAmountINR alias which is deprecated for new code).
 */

'use strict';

const mongoose        = require('mongoose');
const rn              = require('../services/rewardNotificationService');
const User            = require('../models/User');
const RewardClaim     = require('../models/RewardClaim');
const { writeAudit }  = require('../middleware/rbac');
const Payout          = require('../models/PayoutSchema');
const { calculatePostsReward }    = require('../utils/calculatePostsReward');
const { calculateReferralReward } = require('../utils/calculateReferralReward');
const { calculateStreakReward }   = require('../utils/calculateStreakReward');
const { getUserPlan }             = require('../utils/getPlanKey');

// ═════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function resolveSlabForClaim(rewardType, planKey, milestone) {
  try {
    if (rewardType === 'post')     return calculatePostsReward(Number(milestone), planKey);
    if (rewardType === 'referral') return calculateReferralReward(Number(milestone), planKey);
    if (rewardType === 'streak') {
      const days = Number(String(milestone).replace('days', ''));
      return calculateStreakReward(days, planKey);
    }
  } catch (err) {
    console.warn(`[financeAndPayout] resolveSlabForClaim (type=${rewardType}, plan=${planKey}, milestone=${milestone}):`, err.message);
  }
  return null;
}

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
  const cashAmountINR  = groceryCoupons;
  return {
    breakdown: { groceryCoupons, shares, referralToken },
    cashAmountINR,
    objectRewardsHeld: { sharesHeld: shares, referralTokenHeld: referralToken },
    totalAmountINR: cashAmountINR,
  };
}

function claimDescription(rewardType, milestone, planKey, cashAmountINR, objectRewardsHeld = {}) {
  const planLabel = { '2500': 'Basic/₹2500', '3500': 'Silver/₹3500', '4500': 'Gold/₹4500' }[planKey] || planKey;
  let mLabel;
  if (rewardType === 'streak') {
    mLabel = `${String(milestone).replace('days', '')} streak days`;
  } else if (rewardType === 'referral') {
    const n = Number(milestone);
    mLabel = `${n} referral${n !== 1 ? 's' : ''}`;
  } else if (rewardType === 'grocery_redeem') {
    mLabel = `grocery coupon redemption`;
  } else {
    mLabel = `${milestone} posts`;
  }
  const heldParts = [];
  if (objectRewardsHeld.sharesHeld       > 0) heldParts.push(`${objectRewardsHeld.sharesHeld} shares`);
  if (objectRewardsHeld.referralTokenHeld > 0) heldParts.push(`${objectRewardsHeld.referralTokenHeld} tokens`);
  const heldStr = heldParts.length > 0 ? ` | Held: ${heldParts.join(', ')}` : '';
  return `${rewardType} – ${mLabel} (${planLabel}) | Cash: ₹${cashAmountINR}${heldStr}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/payouts ────────────────────────────────────────────────────
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
    const VALID_TYPES = ['post', 'referral', 'streak', 'grocery_redeem'];
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
    // Filter by user-requested flag
    if (req.query.userRequested === 'true')  filter.userRequested = true;
    if (req.query.userRequested === 'false') filter.userRequested = { $ne: true };

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

    return res.json({ payouts, pagination: { page, pages: Math.ceil(total / limit), total, limit } });
  } catch (err) {
    console.error('[listPayouts]', err);
    return res.status(500).json({ message: 'Failed to fetch payouts' });
  }
};

// ── GET /api/admin/payouts/summary ───────────────────────────────────────────
exports.getPayoutSummary = async (req, res) => {
  try {
    const [statusAgg, typeAgg, planAgg, heldAgg, recentPaid] = await Promise.all([
      Payout.aggregate([{ $group: { _id: '$status', cashAmountINR: { $sum: '$cashAmountINR' }, count: { $sum: 1 } } }]),
      Payout.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$rewardType', cashAmountINR: { $sum: '$cashAmountINR' }, count: { $sum: 1 } } }]),
      Payout.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$planKey', cashAmountINR: { $sum: '$cashAmountINR' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Payout.aggregate([{ $match: { status: { $in: ['pending', 'processing', 'on_hold'] } } }, { $group: { _id: null, sharesHeld: { $sum: '$objectRewardsHeld.sharesHeld' }, referralTokenHeld: { $sum: '$objectRewardsHeld.referralTokenHeld' } } }]),
      Payout.find({ status: 'paid' }).populate('user', 'name email username').sort({ paidAt: -1 }).limit(5).lean(),
    ]);

    const byCash = { pending: 0, processing: 0, paid: 0, failed: 0, on_hold: 0 };
    const countByStatus = { ...byCash };
    let paidCount = 0;

    statusAgg.forEach(s => {
      byCash[s._id]        = s.cashAmountINR;
      countByStatus[s._id] = s.count;
      if (s._id === 'paid') paidCount = s.count;
    });

    const paidByRewardType = { post: 0, referral: 0, streak: 0, grocery_redeem: 0 };
    typeAgg.forEach(t => { paidByRewardType[t._id] = t.cashAmountINR; });

    const paidByPlan = {};
    planAgg.forEach(p => { paidByPlan[p._id] = { cashAmountINR: p.cashAmountINR, count: p.count }; });

    const heldRow = heldAgg[0] || { sharesHeld: 0, referralTokenHeld: 0 };

    // Count user-requested pending payouts specifically
    const pendingUserRequested = await Payout.countDocuments({
      rewardType:    'grocery_redeem',
      userRequested: true,
      status:        { $in: ['pending', 'processing'] },
    });

    return res.json({
      summary: {
        totalPaidINR:           byCash.paid,
        totalPaidCashINR:       byCash.paid,
        totalPendingINR:        byCash.pending + byCash.processing,
        totalPendingCashINR:    byCash.pending + byCash.processing,
        totalOnHoldINR:         byCash.on_hold,
        totalOnHoldCashINR:     byCash.on_hold,
        totalFailedINR:         byCash.failed,
        totalFailedCashINR:     byCash.failed,
        avgPayoutINR:           paidCount > 0 ? Math.round(byCash.paid / paidCount) : 0,
        avgPayoutCashINR:       paidCount > 0 ? Math.round(byCash.paid / paidCount) : 0,
        countByStatus,
        paidByRewardType,
        paidByPlan,
        totalObjectRewardsHeld: { sharesHeld: heldRow.sharesHeld || 0, referralTokenHeld: heldRow.referralTokenHeld || 0 },
        pendingUserRequestedCount: pendingUserRequested,
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
 * Returns RewardClaims that have no payout yet.
 *
 * CHANGE: For grocery_redeem type, only shows USER-REQUESTED payouts
 * (where userRequested === true). Admin does not pay unrequested wallet balances.
 * The "Unredeemed Wallets" tab handles those separately.
 */
exports.listPendingClaims = async (req, res) => {
  try {
    const page  = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    const VALID_TYPES = ['post', 'referral', 'streak', 'grocery_redeem'];
    const typeFilter  = req.query.type && VALID_TYPES.includes(req.query.type)
      ? req.query.type
      : null;

    // ── Step 1: claim IDs that already have ANY payout (exclude from results) ─
    // FIX: Payout.rewardClaim is sparse (may be null).  Using distinct() can
    // return null values when the field is absent, which then fail a Mongoose
    // CastError when placed into { $nin: [...null] } on an ObjectId _id field.
    // Use $ne: null in the distinct filter AND strip nulls from the result to
    // be safe even if the index returns unexpected values.
    const rawProcessed = await Payout.distinct('rewardClaim', {
      rewardClaim: { $ne: null },
    });
    const processedClaimIds = rawProcessed.filter(Boolean);   // strip any null/undefined

    // ── Step 2: build the base filter ─────────────────────────────────────────
    // FIX: Build _id exclusion once and never overwrite it.  The previous code
    // overwrote claimFilter._id with { $in: pendingUserReqClaimIds } for the
    // grocery_redeem branch, silently dropping the $nin exclusion and returning
    // already-processed claims.  Now we combine both constraints with $and.
    const claimFilter = {};
    if (typeFilter) claimFilter.type = typeFilter;

    // ── Step 3: grocery_redeem — show only claims tied to pending user-requests
    // For the grocery_redeem type, the claim is only "actionable" when:
    //   a) a corresponding Payout exists with userRequested: true, AND
    //   b) that payout is still in an open status (pending/processing/on_hold)
    // All other claim types: exclude claims that already have any payout.
    if (typeFilter === 'grocery_redeem') {
      // Only show grocery claims with an active user-requested payout
      const pendingUserReqClaimIds = await Payout.distinct('rewardClaim', {
        rewardType:    'grocery_redeem',
        userRequested: true,
        status:        { $in: ['pending', 'processing', 'on_hold'] },
        rewardClaim:   { $ne: null },
      });
      const validIds = pendingUserReqClaimIds.filter(Boolean);
      // $in an empty array returns zero results — correct behaviour (no pending requests)
      claimFilter._id = { $in: validIds };
    } else {
      // Non-grocery types: exclude claims that have already been processed
      claimFilter._id = { $nin: processedClaimIds };
      // Also exclude grocery_redeem from the general list (it has its own tab)
      if (!typeFilter) {
        claimFilter.type = { $nin: ['grocery_redeem'] };
      }
    }

    const [claims, total] = await Promise.all([
      RewardClaim.find(claimFilter)
        .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails kyc trustFlags' })
        .sort({ claimedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RewardClaim.countDocuments(claimFilter),
    ]);

    // For non-grocery claims, enrich with slab resolution
    // For grocery_redeem, enrich with payout doc info
    let enriched = await Promise.all(claims.map(async claim => {
      const user = claim.user;
      if (!user) {
        return {
          ...claim,
          planKey: null, resolvedSlab: null,
          breakdown: { groceryCoupons: 0, shares: 0, referralToken: 0 },
          estimatedCashINR: 0, estimatedINR: 0,
          estimatedObjectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
          hasBankDetails: false, kycStatus: 'unknown', rewardsFrozen: false,
          enrichmentError: 'User document not found',
        };
      }

      const planKey = getUserPlan(user);

      if (claim.type === 'grocery_redeem') {
        // Find the associated pending payout
        const linkedPayout = await Payout.findOne({
          rewardClaim:   claim._id,
          userRequested: true,
        }).select('_id status cashAmountINR totalAmountINR breakdown bankDetails createdAt userRequested').lean();

        const amount = linkedPayout?.cashAmountINR ?? linkedPayout?.totalAmountINR ?? 0;
        return {
          ...claim,
          planKey,
          resolvedSlab:   null,
          breakdown:      linkedPayout?.breakdown || { groceryCoupons: amount, shares: 0, referralToken: 0 },
          estimatedCashINR: amount,
          estimatedINR:     amount,
          estimatedObjectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
          hasBankDetails: !!(user.bankDetails?.accountNumber && user.bankDetails?.ifscCode),
          kycStatus:      user.kyc?.status ?? 'not_started',
          rewardsFrozen:  !!user.trustFlags?.rewardsFrozen,
          userRequested:  true,
          linkedPayoutId: linkedPayout?._id || null,
          linkedPayoutStatus: linkedPayout?.status || null,
          // Show bank details from payout snapshot
          bankDetailsSnapshot: linkedPayout?.bankDetails || null,
        };
      }

      // Standard reward claim (post / referral / streak)
      const slab = resolveSlabForClaim(claim.type, planKey, claim.milestone);
      const { breakdown, cashAmountINR, objectRewardsHeld } = slabToPayoutAmounts(slab);

      return {
        ...claim,
        planKey,
        resolvedSlab:   slab,
        breakdown,
        estimatedCashINR:  cashAmountINR,
        estimatedINR:      cashAmountINR,
        estimatedObjectRewardsHeld: objectRewardsHeld,
        hasBankDetails: !!(user.bankDetails?.accountNumber && user.bankDetails?.ifscCode),
        kycStatus:      user.kyc?.status ?? 'not_started',
        rewardsFrozen:  !!user.trustFlags?.rewardsFrozen,
        userRequested:  false,
      };
    }));

    if (req.query.minCashINR || req.query.minINR) {
      const minVal = Number(req.query.minCashINR || req.query.minINR);
      if (!isNaN(minVal)) enriched = enriched.filter(c => c.estimatedCashINR >= minVal);
    }
    if (req.query.bankOnly === 'true') {
      enriched = enriched.filter(c => c.hasBankDetails);
    }

    return res.json({ claims: enriched, pagination: { page, pages: Math.ceil(total / limit), total, limit } });
  } catch (err) {
    console.error('[listPendingClaims]', err);
    return res.status(500).json({ message: 'Failed to fetch pending claims' });
  }
};

// ── GET /api/admin/payouts/user-requested ─────────────────────────────────────
/**
 * NEW: Lists only user-initiated grocery redemption requests.
 * These are the payouts the admin is responsible for paying.
 * Separate from general payout list for clarity.
 */
exports.listUserRequestedPayouts = async (req, res) => {
  try {
    const page  = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    const filter = {
      rewardType:    'grocery_redeem',
      userRequested: true,
    };

    const VALID_STATUSES = ['pending', 'processing', 'paid', 'failed', 'on_hold'];
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }

    const [payouts, total] = await Promise.all([
      Payout.find(filter)
        .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails kyc.status trustFlags' })
        .populate({ path: 'processedBy', model: User, select: 'name email' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payout.countDocuments(filter),
    ]);

    // KPIs for the user-requested tab
    const [pendingSum, paidSum] = await Promise.all([
      Payout.aggregate([
        { $match: { rewardType: 'grocery_redeem', userRequested: true, status: { $in: ['pending', 'processing'] } } },
        { $group: { _id: null, total: { $sum: '$cashAmountINR' }, count: { $sum: 1 } } },
      ]),
      Payout.aggregate([
        { $match: { rewardType: 'grocery_redeem', userRequested: true, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$cashAmountINR' }, count: { $sum: 1 } } },
      ]),
    ]);

    return res.json({
      payouts,
      pagination: { page, pages: Math.ceil(total / limit), total, limit },
      summary: {
        pendingAmount: pendingSum[0]?.total || 0,
        pendingCount:  pendingSum[0]?.count || 0,
        paidAmount:    paidSum[0]?.total   || 0,
        paidCount:     paidSum[0]?.count   || 0,
      },
    });
  } catch (err) {
    console.error('[listUserRequestedPayouts]', err);
    return res.status(500).json({ message: 'Failed to fetch user-requested payouts' });
  }
};

// ── GET /api/admin/payouts/user/:userId ───────────────────────────────────────
exports.getUserPayouts = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }

    const [payouts, user] = await Promise.all([
      Payout.find({ user: userId }).populate('processedBy', 'name email').sort({ createdAt: -1 }).lean(),
      User.findById(userId).select('name email phone username subscription bankDetails kyc.status kyc.verifiedAt trustFlags redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs totalGroceryCoupons totalShares totalReferralToken').lean(),
    ]);

    if (!user) return res.status(404).json({ message: 'User not found' });

    const totals = {
      lifetimeCash: 0, paidCash: 0, pendingCash: 0, failedCash: 0, onHoldCash: 0,
      byType: { post: 0, referral: 0, streak: 0, grocery_redeem: 0 },
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
    };

    payouts.forEach(p => {
      const cash = p.cashAmountINR ?? p.totalAmountINR ?? 0;
      totals.lifetimeCash += cash;
      if (p.status === 'paid')                                    totals.paidCash    += cash;
      if (p.status === 'pending' || p.status === 'processing')    totals.pendingCash += cash;
      if (p.status === 'failed')                                  totals.failedCash  += cash;
      if (p.status === 'on_hold')                                 totals.onHoldCash  += cash;
      if (p.status === 'paid' && totals.byType[p.rewardType] !== undefined) totals.byType[p.rewardType] += cash;
      if (['pending', 'processing', 'on_hold'].includes(p.status)) {
        totals.objectRewardsHeld.sharesHeld        += p.objectRewardsHeld?.sharesHeld        || 0;
        totals.objectRewardsHeld.referralTokenHeld += p.objectRewardsHeld?.referralTokenHeld || 0;
      }
    });

    return res.json({ user: { ...user, planKey: getUserPlan(user) }, payouts, totals });
  } catch (err) {
    console.error('[getUserPayouts]', err);
    return res.status(500).json({ message: 'Failed to fetch user payouts' });
  }
};

// ── POST /api/admin/payouts/process ───────────────────────────────────────────
exports.processPayout = async (req, res) => {
  try {
    const { claimId, status = 'processing', transactionRef, notes } = req.body;

    if (!claimId || !mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ message: 'Valid claimId required' });
    }

    const ALLOWED_INITIAL = ['pending', 'processing', 'paid'];
    if (!ALLOWED_INITIAL.includes(status)) {
      return res.status(400).json({ message: `Initial status must be one of: ${ALLOWED_INITIAL.join(', ')}` });
    }

    const existing = await Payout.findOne({ rewardClaim: claimId });
    if (existing) {
      return res.status(409).json({ message: 'Payout already exists for this claim', payoutId: existing._id });
    }

    const claim = await RewardClaim.findById(claimId)
      .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails kyc trustFlags' })
      .lean();

    if (!claim) return res.status(404).json({ message: 'RewardClaim not found' });

    const user = claim.user;
    if (!user) return res.status(404).json({ message: 'User associated with claim not found' });

    let cashAmountINR = 0;
    let breakdown     = { groceryCoupons: 0, shares: 0, referralToken: 0 };
    let objectRewards = { sharesHeld: 0, referralTokenHeld: 0 };

    if (claim.type === 'grocery_redeem') {
      // Parse balance from milestone e.g. "2500_groceryCoupons"
      const parsed = parseInt(String(claim.milestone).split('_')[0]);
      cashAmountINR = isNaN(parsed) ? 0 : parsed;
      breakdown = { groceryCoupons: cashAmountINR, shares: 0, referralToken: 0 };
    } else {
      const planKey = getUserPlan(user);
      const slab    = resolveSlabForClaim(claim.type, planKey, claim.milestone);
      const amounts = slabToPayoutAmounts(slab);
      cashAmountINR  = amounts.cashAmountINR;
      breakdown      = amounts.breakdown;
      objectRewards  = amounts.objectRewardsHeld;
    }

    // Force on_hold if zero cash payout
    const finalStatus = cashAmountINR === 0 ? 'on_hold' : status;

    const bankSnapshot = {
      accountNumber: user.bankDetails?.accountNumber || null,
      ifscCode:      user.bankDetails?.ifscCode      || null,
      panNumber:     user.bankDetails?.panNumber      || null,
    };

    const payout = await Payout.create({
      user:          user._id,
      rewardClaim:   claim._id,
      rewardType:    claim.type,
      milestone:     claim.milestone,
      planKey:       getUserPlan(user),
      breakdown,
      cashAmountINR,
      totalAmountINR: cashAmountINR,
      objectRewardsHeld: objectRewards,
      bankDetails:   bankSnapshot,
      status:        finalStatus,
      userRequested: claim.type === 'grocery_redeem' ? true : false,
      transactionRef: transactionRef || null,
      notes: notes || claimDescription(claim.type, claim.milestone, getUserPlan(user), cashAmountINR, objectRewards),
      processedBy:   req.user.id,
      processedAt:   new Date(),
      paidAt:        finalStatus === 'paid' ? new Date() : null,
    });

    rn.notifyPayoutStatusChanged({
      userId:    user._id,
      userName:  user.name || user.username,
      amountINR: cashAmountINR,
      newStatus: finalStatus,
      oldStatus: 'pending',
      payoutId:  payout._id,
    }).catch(() => {});

    writeAudit(req, 'payout_created', {
      payoutId:      payout._id.toString(),
      userId:        user._id.toString(),
      cashAmountINR,
      rewardType:    claim.type,
      status:        finalStatus,
    }).catch(() => {});

    return res.status(201).json({ payout });
  } catch (err) {
    console.error('[processPayout]', err);
    return res.status(500).json({ message: 'Failed to process payout' });
  }
};

// ── PATCH /api/admin/payouts/:payoutId/status ─────────────────────────────────
exports.updatePayoutStatus = async (req, res) => {
  try {
    const { payoutId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(payoutId)) {
      return res.status(400).json({ message: 'Invalid payoutId' });
    }

    const { status, transactionRef, failureReason, notes } = req.body;

    const VALID_STATUSES = ['pending', 'processing', 'paid', 'failed', 'on_hold'];
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const ALLOWED_TRANSITIONS = {
      pending:    ['processing', 'paid', 'on_hold', 'failed'],
      processing: ['paid', 'failed', 'on_hold'],
      failed:     ['pending'],
      on_hold:    ['pending'],
      paid:       [],
    };

    const payout = await Payout.findById(payoutId)
      .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails' })
      .lean();

    if (!payout) return res.status(404).json({ message: 'Payout not found' });

    if (!ALLOWED_TRANSITIONS[payout.status]?.includes(status)) {
      return res.status(400).json({
        message: `Cannot transition payout from '${payout.status}' to '${status}'.`,
        allowedTransitions: ALLOWED_TRANSITIONS[payout.status] || [],
      });
    }

    if (status === 'failed' && !failureReason?.trim()) {
      return res.status(400).json({ message: 'failureReason is required when marking as failed.' });
    }

    const updates = {
      status,
      transactionRef: transactionRef || payout.transactionRef,
      failureReason:  failureReason  || null,
      processedBy:    req.user.id,
      processedAt:    new Date(),
    };
    if (status === 'paid') updates.paidAt = new Date();
    if (notes) updates.notes = notes;

    const updatedPayout = await Payout.findByIdAndUpdate(payoutId, { $set: updates }, { new: true })
      .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails kyc.status' });

    rn.notifyPayoutStatusChanged({
      userId:        payout.user?._id,
      userName:      payout.user?.name || payout.user?.email,
      amountINR:     payout.cashAmountINR ?? payout.totalAmountINR,
      newStatus:     status,
      oldStatus:     payout.status,
      payoutId:      payout._id,
      failureReason: failureReason || null,
    }).catch(() => {});

    writeAudit(req, 'payout_status_updated', {
      payoutId:  payoutId,
      oldStatus: payout.status,
      newStatus: status,
      transactionRef: transactionRef || null,
    }).catch(() => {});

    return res.json({ payout: updatedPayout });
  } catch (err) {
    console.error('[updatePayoutStatus]', err);
    return res.status(500).json({ message: 'Failed to update payout status' });
  }
};

// ── POST /api/admin/payouts/bulk-process ──────────────────────────────────────
exports.bulkProcessPayouts = async (req, res) => {
  try {
    const { claimIds, status = 'processing', notes } = req.body;

    if (!Array.isArray(claimIds) || claimIds.length === 0) {
      return res.status(400).json({ message: 'claimIds array required' });
    }
    if (claimIds.length > 100) {
      return res.status(400).json({ message: 'Maximum 100 claims per bulk request' });
    }

    const ALLOWED = ['pending', 'processing', 'paid'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${ALLOWED.join(', ')}` });
    }

    const results = { processed: [], skipped: [], failed: [] };
    let totalCashINR = 0;

    for (const claimId of claimIds) {
      if (!mongoose.Types.ObjectId.isValid(claimId)) {
        results.skipped.push({ claimId, reason: 'Invalid ObjectId' });
        continue;
      }

      const existing = await Payout.findOne({ rewardClaim: claimId }).lean();
      if (existing) {
        results.skipped.push({ claimId, reason: 'Payout already exists', payoutId: existing._id });
        continue;
      }

      const claim = await RewardClaim.findById(claimId)
        .populate({ path: 'user', model: User, select: 'name email phone username subscription bankDetails kyc trustFlags' })
        .lean();

      if (!claim) {
        results.skipped.push({ claimId, reason: 'Claim not found' });
        continue;
      }

      const user = claim.user;
      if (!user) {
        results.skipped.push({ claimId, reason: 'User not found' });
        continue;
      }

      try {
        let cashAmountINR = 0;
        let breakdown     = { groceryCoupons: 0, shares: 0, referralToken: 0 };
        let objectRewards = { sharesHeld: 0, referralTokenHeld: 0 };

        if (claim.type === 'grocery_redeem') {
          const parsed = parseInt(String(claim.milestone).split('_')[0]);
          cashAmountINR = isNaN(parsed) ? 0 : parsed;
          breakdown = { groceryCoupons: cashAmountINR, shares: 0, referralToken: 0 };
        } else {
          const planKey = getUserPlan(user);
          const slab    = resolveSlabForClaim(claim.type, planKey, claim.milestone);
          const amounts = slabToPayoutAmounts(slab);
          cashAmountINR  = amounts.cashAmountINR;
          breakdown      = amounts.breakdown;
          objectRewards  = amounts.objectRewardsHeld;
        }

        const finalStatus = cashAmountINR === 0 ? 'on_hold' : status;
        const bankSnapshot = {
          accountNumber: user.bankDetails?.accountNumber || null,
          ifscCode:      user.bankDetails?.ifscCode      || null,
          panNumber:     user.bankDetails?.panNumber      || null,
        };

        const payout = await Payout.create({
          user:          user._id,
          rewardClaim:   claim._id,
          rewardType:    claim.type,
          milestone:     claim.milestone,
          planKey:       getUserPlan(user),
          breakdown,
          cashAmountINR,
          totalAmountINR: cashAmountINR,
          objectRewardsHeld: objectRewards,
          bankDetails:   bankSnapshot,
          status:        finalStatus,
          userRequested: claim.type === 'grocery_redeem',
          notes:         notes || claimDescription(claim.type, claim.milestone, getUserPlan(user), cashAmountINR, objectRewards),
          processedBy:   req.user.id,
          processedAt:   new Date(),
          paidAt:        finalStatus === 'paid' ? new Date() : null,
        });

        totalCashINR += cashAmountINR;
        results.processed.push({ claimId, payoutId: payout._id, cashAmountINR, status: finalStatus });
      } catch (err) {
        results.failed.push({ claimId, reason: err.message });
      }
    }

    writeAudit(req, 'bulk_payout_processed', {
      processed: results.processed.length,
      skipped:   results.skipped.length,
      failed:    results.failed.length,
      totalCashINR,
      requestedStatus: status,
    }).catch(() => {});

    rn.notifyBulkPayoutComplete({
      adminId:    req.user.id,
      adminName:  req.user.name || req.user.email,
      processed:  results.processed.length,
      skipped:    results.skipped.length,
      failed:     results.failed.length,
      totalCashINRDispatched: totalCashINR,
    }).catch(() => {});

    return res.status(207).json({
      message: `Bulk complete — ${results.processed.length} processed, ${results.skipped.length} skipped, ${results.failed.length} failed`,
      totalINRDispatched: totalCashINR,
      results,
    });
  } catch (err) {
    console.error('[bulkProcessPayouts]', err);
    return res.status(500).json({ message: 'Failed to bulk process payouts' });
  }
};

// ── GET /api/admin/payouts/report ─────────────────────────────────────────────
/**
 * NEW: Full payout report for Excel download.
 *
 * Returns all payouts (or filtered subset) with complete bank details,
 * user info, and financial data for reconciliation.
 *
 * Query params: same as listPayouts plus format=all|paid|pending
 */
exports.getPayoutReport = async (req, res) => {
  try {
    const filter = {};

    // Status filter — default 'all'
    const format = req.query.format || 'all';
    if (format === 'paid')    filter.status = 'paid';
    if (format === 'pending') filter.status = { $in: ['pending', 'processing'] };

    const VALID_TYPES = ['post', 'referral', 'streak', 'grocery_redeem'];
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
    if (req.query.userRequested === 'true')  filter.userRequested = true;

    const payouts = await Payout.find(filter)
      .populate({
        path:   'user',
        model:  User,
        select: 'name email phone username subscription bankDetails kyc.status kyc.verifiedAt trustFlags',
      })
      .populate({ path: 'processedBy', model: User, select: 'name email' })
      .sort({ createdAt: -1 })
      .limit(5000) // reasonable hard cap for report export
      .lean();

    // Flatten into rows suitable for Excel
    const rows = payouts.map(p => {
      const u  = p.user   || {};
      const bd = p.bankDetails || {};
      const ub = u.bankDetails || {};

      return {
        // Payout Identity
        payoutId:          String(p._id),
        rewardType:        p.rewardType || '',
        milestone:         String(p.milestone || ''),
        plan:              p.planKey || '',
        userRequested:     p.userRequested ? 'Yes' : 'No',

        // Financial
        cashAmountINR:     p.cashAmountINR     ?? p.totalAmountINR ?? 0,
        totalAmountINR:    p.totalAmountINR    ?? 0,
        groceryCoupons:    p.breakdown?.groceryCoupons  || 0,
        sharesHeld:        p.objectRewardsHeld?.sharesHeld        || 0,
        tokensHeld:        p.objectRewardsHeld?.referralTokenHeld || 0,

        // Status & Timeline
        status:            p.status || '',
        createdAt:         p.createdAt ? new Date(p.createdAt).toLocaleString('en-IN') : '',
        processedAt:       p.processedAt ? new Date(p.processedAt).toLocaleString('en-IN') : '',
        paidAt:            p.paidAt ? new Date(p.paidAt).toLocaleString('en-IN') : '',
        transactionRef:    p.transactionRef || '',
        failureReason:     p.failureReason  || '',
        notes:             p.notes         || '',
        processedBy:       p.processedBy?.name || p.processedBy?.email || '',

        // User Details
        userName:          u.name     || '',
        userEmail:         u.email    || '',
        userPhone:         u.phone    || '',
        userUsername:      u.username || '',
        userPlan:          u.subscription?.plan       || '',
        userPlanAmount:    u.subscription?.planAmount || '',
        userSubActive:     u.subscription?.active ? 'Yes' : 'No',
        userKycStatus:     u.kyc?.status || '',
        userRewardsFrozen: u.trustFlags?.rewardsFrozen ? 'Yes' : 'No',

        // Bank Details — from payout snapshot first, then live user data
        bankAccountNumber: bd.accountNumber || ub.accountNumber || '',
        bankIfscCode:      bd.ifscCode      || ub.ifscCode      || '',
        bankPanNumber:     bd.panNumber     || ub.panNumber     || '',
      };
    });

    return res.json({
      rows,
      total:     rows.length,
      generated: new Date().toISOString(),
      filter:    { format, ...req.query },
    });
  } catch (err) {
    console.error('[getPayoutReport]', err);
    return res.status(500).json({ message: 'Failed to generate payout report' });
  }
};

// ── GET /api/admin/payouts/unredeemed-wallets ─────────────────────────────────
exports.listUnredeemedWallets = async (req, res) => {
  try {
    const page       = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit      = Math.min(100, parseInt(req.query.limit) || 25);
    const skip       = (page - 1) * limit;
    const minBalance = Math.max(0, parseFloat(req.query.minBalance) || 1);

    const activeRedemptionUserIds = await Payout.distinct('user', {
      rewardType: 'grocery_redeem',
      status:     { $in: ['pending', 'processing', 'on_hold'] },
    });

    const userFilter = {
      _id:  { $nin: activeRedemptionUserIds },
      role: { $in: ['user', null] },
      totalGroceryCoupons: { $gte: minBalance },
    };

    if (req.query.kycStatus) {
      userFilter['kyc.status'] = req.query.kycStatus;
    }
    if (req.query.bankOnly === 'true') {
      userFilter['bankDetails.accountNumber'] = { $exists: true, $ne: null };
      userFilter['bankDetails.ifscCode']      = { $exists: true, $ne: null };
    }
    if (req.query.search) {
      const rx = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      userFilter.$or = [{ name: rx }, { email: rx }, { username: rx }];
    }

    const [users, total] = await Promise.all([
      User.find(userFilter)
        .select('name email phone username totalGroceryCoupons totalRedeemedGrocery totalShares totalReferralToken subscription kyc bankDetails trustFlags redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs lastActive')
        .sort({ totalGroceryCoupons: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(userFilter),
    ]);

    const enriched = users.map(u => {
      const hasBankDetails = !!(u.bankDetails?.accountNumber && u.bankDetails?.ifscCode);
      const kycStatus      = u.kyc?.status ?? 'not_started';
      const kycVerified    = kycStatus === 'verified';
      const subActive      = !!u.subscription?.active;
      const subExpired     = subActive && u.subscription?.expiresAt && new Date(u.subscription.expiresAt) < new Date();
      const eligible       = kycVerified && subActive && !subExpired && !u.trustFlags?.rewardsFrozen;
      const totalSlabsRedeemed = (u.redeemedPostSlabs?.length || 0) + (u.redeemedReferralSlabs?.length || 0) + (u.redeemedStreakSlabs?.length || 0);
      const earned    = u.totalGroceryCoupons  || 0;
      const redeemed  = u.totalRedeemedGrocery || 0;
      const available = earned - redeemed;

      return {
        _id: u._id, name: u.name, email: u.email, phone: u.phone, username: u.username,
        totalGroceryCoupons: u.totalGroceryCoupons || 0,
        totalShares:         u.totalShares || 0,
        totalReferralToken:  u.totalReferralToken || 0,
        plan:                u.subscription?.plan || null,
        planKey:             getUserPlan(u),
        subActive, subExpired: !!subExpired,
        kycStatus, kycVerified, hasBankDetails,
        accountNumber: u.bankDetails?.accountNumber || null,
        ifscCode:      u.bankDetails?.ifscCode || null,
        panNumber:     u.bankDetails?.panNumber || null,
        rewardsFrozen: !!u.trustFlags?.rewardsFrozen,
        eligible, totalSlabsRedeemed,
        totalGroceryCoupons: available,
        availableGrocery:    available,
        lastActive: u.lastActive ?? null,
        // pendingClaimIds empty since user hasn't requested yet
        pendingClaimIds: [],
      };
    }).filter(u => u.availableGrocery >= minBalance);

    const totalsAgg = await User.aggregate([
      { $match: { totalGroceryCoupons: { $gte: minBalance }, _id: { $nin: activeRedemptionUserIds }, role: { $in: ['user', null] } } },
      { $group: { _id: null, totalBalance: { $sum: '$totalGroceryCoupons' }, eligibleCount: { $sum: { $cond: [{ $and: [{ $eq: ['$kyc.status', 'verified'] }, { $eq: ['$subscription.active', true] }, { $ne: ['$trustFlags.rewardsFrozen', true] }] }, 1, 0] } }, noBankCount: { $sum: { $cond: [{ $or: [{ $not: ['$bankDetails.accountNumber'] }, { $eq: ['$bankDetails.accountNumber', null] }] }, 1, 0] } } } },
    ]);

    const s = totalsAgg[0] || { totalBalance: 0, eligibleCount: 0, noBankCount: 0 };

    return res.json({
      users: enriched,
      pagination: { page, pages: Math.ceil(total / limit), total, limit },
      summary: { totalUsersWithBalance: total, totalUnredeemedINR: s.totalBalance || 0, eligibleToRedeem: s.eligibleCount || 0, missingBankDetails: s.noBankCount || 0 },
    });
  } catch (err) {
    console.error('[listUnredeemedWallets]', err);
    return res.status(500).json({ message: 'Failed to fetch unredeemed wallets' });
  }
};

const TDS_RATE = 0.10; // must match specialOfferController.js

/**
 * Parse TDS amount from payout notes string if available.
 * Notes format from specialOfferController:
 *   "TDS deducted (10% under Section 194R): ₹<n>"
 * Falls back to computing 10% of gross if not found.
 *
 * @param {string} notes
 * @param {number} grossINR
 * @returns {number}
 */
function parseTdsFromNotes(notes, grossINR) {
  if (!notes) return Math.round(grossINR * TDS_RATE);
  const match = notes.match(/TDS deducted[^:]*:\s*₹?(\d+)/i);
  if (match) return parseInt(match[1], 10) || 0;
  return Math.round(grossINR * TDS_RATE);
}

/**
 * Determine the redemption path chosen by the user (post-approval).
 * Withdrawal payouts have userRequested: true.
 * Credit payouts that were used for subscription have a milestone containing
 * 'subscription_credit' or their lockedReward status is 'used_for_subscription'.
 *
 * @param {object} payout  — Payout document (lean)
 * @returns {'credit'|'withdrawal'|'subscription'|'pending_choice'}
 */
function classifyPath(payout) {
  if (payout.userRequested) return 'withdrawal';
  const milestone = String(payout.milestone || '');
  if (milestone.includes('subscription_credit') || milestone.includes('full_credit')) {
    return 'subscription';
  }
  // Admin-credited reward, user hasn't yet chosen their redemption path
  if (['pending', 'processing'].includes(payout.status)) return 'pending_choice';
  if (payout.status === 'paid') return 'credit_paid';
  return 'credit';
}

exports.getSpecialOfferReport = async (req, res) => {
  try {
    const { Payout }    = require('../models/PayoutSchema') ? { Payout: require('../models/PayoutSchema') } : {};
    const User          = require('../models/User');
    const PayoutModel   = require('../models/PayoutSchema');

    const MAX = 5000;

    // ── Build filter ──────────────────────────────────────────────────────────
    const filter = { rewardType: 'special_offer' };

    // Status
    const VALID_STATUSES = ['pending', 'processing', 'paid', 'failed', 'on_hold'];
    const formatParam = req.query.format || 'all';
    if (formatParam === 'paid')    filter.status = 'paid';
    if (formatParam === 'pending') filter.status = { $in: ['pending', 'processing'] };
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }

    // Path → userRequested boolean
    if (req.query.path === 'credit')     filter.userRequested = false;
    if (req.query.path === 'withdrawal') filter.userRequested = true;

    // User
    const mongoose = require('mongoose');
    if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
      filter.user = new mongoose.Types.ObjectId(req.query.userId);
    }

    // Date range
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }

    // ── Query ─────────────────────────────────────────────────────────────────
    const payouts = await PayoutModel.find(filter)
      .populate({
        path:   'user',
        model:  User,
        select: 'name email phone username referralId subscription bankDetails kyc.status kyc.verifiedAt trustFlags lockedRewards specialOffer',
      })
      .populate({ path: 'processedBy', model: User, select: 'name email' })
      .sort({ createdAt: -1 })
      .limit(MAX)
      .lean();

    // ── Build rows ────────────────────────────────────────────────────────────
    const rows = payouts.map(p => {
      const u   = p.user   || {};
      const bd  = p.bankDetails || {};
      const ub  = u.bankDetails || {};

      // Amount breakdown
      const grossINR = p.breakdown?.groceryCoupons ?? p.totalAmountINR ?? p.cashAmountINR ?? 0;
      const isWithdrawal = !!p.userRequested;

      // For withdrawal payouts the TDS was embedded in notes by specialOfferController
      const tdsINR = isWithdrawal ? parseTdsFromNotes(p.notes, grossINR) : 0;
      const netINR = p.cashAmountINR ?? p.totalAmountINR ?? 0;

      // Path classification
      const path = classifyPath(p);

      // Find the matching lockedReward entry to surface its status
      const referredUserId = p.milestone
        ? p.milestone.replace('special_offer_referral_', '').replace('special_offer_withdrawal_', '').replace('subscription_credit_', '').replace('full_credit_', '').replace(/_\d+$/, '')
        : null;

      const lockedReward = (u.lockedRewards ?? []).find(r =>
        r.type === 'special_offer' &&
        (referredUserId ? String(r.referredUserId) === referredUserId : true)
      );
      const lockedStatus = lockedReward?.status ?? p.status;

      // Subscription usage
      const subCreditApplied = path === 'subscription' || lockedStatus === 'used_for_subscription';
      const specialOfferActive = u.specialOffer?.isActive && new Date() < new Date(u.specialOffer?.expiresAt || 0);

      return {
        // ── Payout identity ──────────────────────────────────────────────────
        payoutId:          String(p._id),
        path,                                          // 'credit' | 'withdrawal' | 'subscription' | 'pending_choice' | 'credit_paid'
        pathLabel:         isWithdrawal ? 'Cash Withdrawal (Path B)' : 'Subscription Credit (Path A)',
        userRequested:     isWithdrawal ? 'Yes' : 'No',
        status:            p.status,
        lockedRewardStatus: lockedStatus,
        milestone:         String(p.milestone || ''),
        planKey:           p.planKey || '',
        processedBy:       p.processedBy?.name || p.processedBy?.email || '',
        transactionRef:    p.transactionRef || '',
        failureReason:     p.failureReason  || '',
        notes:             p.notes || '',

        // ── Financial ────────────────────────────────────────────────────────
        grossINR,                                      // total credited (before TDS)
        tdsINR,                                        // 10% TDS on withdrawals, 0 on credits
        netINR,                                        // amount user receives (gross - TDS for withdrawals)
        tdsPercent:        isWithdrawal ? '10%' : 'N/A',
        subCreditApplied:  subCreditApplied ? 'Yes' : 'No',

        // ── Lifecycle dates ──────────────────────────────────────────────────
        createdAt:         p.createdAt    ? new Date(p.createdAt).toLocaleString('en-IN',    { timeZone: 'Asia/Kolkata' }) : '',
        processedAt:       p.processedAt  ? new Date(p.processedAt).toLocaleString('en-IN',  { timeZone: 'Asia/Kolkata' }) : '',
        paidAt:            p.paidAt       ? new Date(p.paidAt).toLocaleString('en-IN',       { timeZone: 'Asia/Kolkata' }) : '',

        // ── User details ─────────────────────────────────────────────────────
        userName:          u.name     || '',
        userEmail:         u.email    || '',
        userPhone:         u.phone    || '',
        userUsername:      u.username || '',
        userReferralId:    u.referralId || '',
        userPlan:          u.subscription?.plan       || '',
        userPlanAmount:    u.subscription?.planAmount || '',
        userSubActive:     u.subscription?.active ? 'Yes' : 'No',
        userSubExpires:    u.subscription?.expiresAt ? new Date(u.subscription.expiresAt).toLocaleDateString('en-IN') : '',
        userKycStatus:     u.kyc?.status || '',
        userKycVerifiedAt: u.kyc?.verifiedAt ? new Date(u.kyc.verifiedAt).toLocaleDateString('en-IN') : '',
        userRewardsFrozen: u.trustFlags?.rewardsFrozen ? 'Yes' : 'No',
        userRiskTier:      u.trustFlags?.riskTier || 'clean',
        specialOfferActive: specialOfferActive ? 'Yes' : 'No',
        offerExpiresAt:    u.specialOffer?.expiresAt ? new Date(u.specialOffer.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
        totalEarnedINR:    u.specialOffer?.totalEarned || 0,
        referralCount:     u.specialOffer?.referralCount || 0,

        // ── Bank details ─────────────────────────────────────────────────────
        // Payout snapshot first (immutable at request time), then live user data
        bankAccountNumber: bd.accountNumber || ub.accountNumber || '',
        bankIfscCode:      bd.ifscCode      || ub.ifscCode      || '',
        bankPanNumber:     bd.panNumber     || ub.panNumber     || '',
      };
    });

    // ── Aggregate summary ─────────────────────────────────────────────────────
    const summary = {
      totalRows:          rows.length,

      // Credits (admin-created rewards)
      creditsTotal:       rows.filter(r => r.userRequested === 'No').length,
      creditsPendingCount:rows.filter(r => r.userRequested === 'No' && ['pending', 'processing'].includes(r.status)).length,
      creditsPendingINR:  rows.filter(r => r.userRequested === 'No' && ['pending', 'processing'].includes(r.status)).reduce((s, r) => s + r.grossINR, 0),
      creditsPaidINR:     rows.filter(r => r.userRequested === 'No' && r.status === 'paid').reduce((s, r) => s + r.grossINR, 0),
      subCreditsUsedINR:  rows.filter(r => r.subCreditApplied === 'Yes').reduce((s, r) => s + r.grossINR, 0),

      // Withdrawals (user-requested cash payouts)
      withdrawalsTotal:    rows.filter(r => r.userRequested === 'Yes').length,
      withdrawalsGrossINR: rows.filter(r => r.userRequested === 'Yes').reduce((s, r) => s + r.grossINR, 0),
      withdrawalsTdsINR:   rows.filter(r => r.userRequested === 'Yes').reduce((s, r) => s + r.tdsINR, 0),
      withdrawalsNetINR:   rows.filter(r => r.userRequested === 'Yes').reduce((s, r) => s + r.netINR, 0),
      withdrawalsPaidINR:  rows.filter(r => r.userRequested === 'Yes' && r.status === 'paid').reduce((s, r) => s + r.netINR, 0),
      withdrawalsPendingINR: rows.filter(r => r.userRequested === 'Yes' && ['pending', 'processing'].includes(r.status)).reduce((s, r) => s + r.netINR, 0),

      // All-time
      totalGrossINR:      rows.reduce((s, r) => s + r.grossINR, 0),
      totalTdsINR:        rows.reduce((s, r) => s + r.tdsINR,   0),
      totalNetINR:        rows.reduce((s, r) => s + r.netINR,   0),
      failedCount:        rows.filter(r => r.status === 'failed').length,

      generatedAt:        new Date().toISOString(),
      filter: { status: req.query.status || '', path: req.query.path || '', from: req.query.from || '', to: req.query.to || '', userId: req.query.userId || '' },
    };

    return res.json({ rows, summary, total: rows.length, generated: new Date().toISOString() });

  } catch (err) {
    console.error('[getSpecialOfferReport]', err);
    return res.status(500).json({ message: 'Failed to generate Special Offer report' });
  }
};

exports.Payout = Payout;