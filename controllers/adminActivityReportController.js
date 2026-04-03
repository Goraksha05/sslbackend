/**
 * controllers/adminActivityReportController.js
 *
 * Deep per-user activity report for admins.
 *
 * GET /api/admin/reports/activity
 *   Returns paginated user list with post counts, referral counts,
 *   streak counts, claimed slabs, in-progress slabs, and wallet totals.
 *   Supports search, plan filter, KYC status filter, and date range.
 *
 * GET /api/admin/reports/activity/:userId
 *   Full detail for one user — used by the detail drawer.
 *
 * GET /api/admin/reports/activity/export
 *   Same as list but returns ALL records (no pagination) for export.
 *   Max 5000 records per request to protect against OOM.
 */

'use strict';

const mongoose    = require('mongoose');
const User        = require('../models/User');
const Activity    = require('../models/Activity');
const Posts       = require('../models/Posts');
const RewardClaim = require('../models/RewardClaim');
const Payout      = require('../models/PayoutSchema');
const { readRewards } = require('../utils/rewardManager');
const { getUserPlan } = require('../utils/getPlanKey');

// ── INR conversion (mirrors financeAndPayoutController) ─────────────────────
const SHARE_INR  = 1;
const TOKEN_INR  = 1;

function slabToINR(slab) {
  if (!slab) return 0;
  return (slab.groceryCoupons || 0)
    + (slab.shares || 0)        * SHARE_INR
    + (slab.referralToken || 0) * TOKEN_INR;
}

function resolveSlabINR(type, planKey, milestone) {
  try {
    const slabs = readRewards(type === 'post' ? 'posts' : type, planKey);
    let slab = null;
    if (type === 'post')     slab = slabs.find(s => s.postsCount      === Number(milestone));
    if (type === 'referral') slab = slabs.find(s => s.referralCount   === Number(milestone));
    if (type === 'streak')   slab = slabs.find(s => s.dailystreak     === parseInt(String(milestone)));
    return slabToINR(slab);
  } catch { return 0; }
}

// ── Next-unclaimed slab helper ──────────────────────────────────────────────
function nextSlabInfo(type, planKey, currentCount, redeemedSlabs) {
  try {
    const slabs = readRewards(type === 'post' ? 'posts' : type, planKey);
    let countKey, redeemedNorm;

    if (type === 'post') {
      countKey     = 'postsCount';
      redeemedNorm = (redeemedSlabs || []).map(Number);
    } else if (type === 'referral') {
      countKey     = 'referralCount';
      redeemedNorm = (redeemedSlabs || []).map(Number);
    } else {
      countKey     = 'dailystreak';
      redeemedNorm = (redeemedSlabs || []).map(s => parseInt(String(s)));
    }

    const next = slabs
      .filter(s => !redeemedNorm.includes(s[countKey]))
      .sort((a, b) => a[countKey] - b[countKey])
      .find(s => s[countKey] > currentCount);

    if (!next) return null;
    const needed = next[countKey] - currentCount;
    return {
      milestone:    next[countKey],
      needed,
      progress:     Math.round((currentCount / next[countKey]) * 100),
      estimatedINR: slabToINR(next),
    };
  } catch { return null; }
}

// ── Aggregate per-user activity stats ───────────────────────────────────────
async function buildUserStats(users) {
  if (!users.length) return {};

  const userIds = users.map(u => u._id);

  // Batch all DB queries in parallel
  const [postCounts, refCounts, streakCounts, claims, payouts] = await Promise.all([
    // Post counts (non-rejected)
    Posts.aggregate([
      { $match: { user_id: { $in: userIds }, 'moderation.status': { $ne: 'rejected' } } },
      { $group: { _id: '$user_id', count: { $sum: 1 } } },
    ]),

    // Referral counts (users who signed up using this user's ref code)
    User.aggregate([
      { $match: { referral: { $in: userIds } } },
      { $group: { _id: '$referral', total: { $sum: 1 }, active: {
        $sum: { $cond: [{ $eq: ['$subscription.active', true] }, 1, 0] }
      }}},
    ]),

    // Unique streak days per user
    Activity.aggregate([
      { $match: { user: { $in: userIds }, dailystreak: { $exists: true, $ne: null } } },
      { $group: {
        _id: {
          user: '$user',
          day:  { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        },
      }},
      { $group: { _id: '$_id.user', uniqueDays: { $sum: 1 } } },
    ]),

    // All reward claims
    RewardClaim.find({ user: { $in: userIds } })
      .select('user type milestone claimedAt')
      .lean(),

    // Payout totals
    Payout.aggregate([
      { $match: { user: { $in: userIds } } },
      { $group: {
        _id: '$user',
        totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$totalAmountINR', 0] } },
        totalPending: { $sum: { $cond: [
          { $in: ['$status', ['pending', 'processing']] }, '$totalAmountINR', 0
        ]}},
        payoutCount: { $sum: 1 },
      }},
    ]),
  ]);

  // Index by userId string
  const postMap     = Object.fromEntries(postCounts.map(p => [String(p._id), p.count]));
  const refMap      = Object.fromEntries(refCounts.map(r => [String(r._id), { total: r.total, active: r.active }]));
  const streakMap   = Object.fromEntries(streakCounts.map(s => [String(s._id), s.uniqueDays]));
  const payoutMap   = Object.fromEntries(payouts.map(p => [String(p._id), p]));

  // Group claims by userId
  const claimsByUser = {};
  for (const c of claims) {
    const uid = String(c.user);
    if (!claimsByUser[uid]) claimsByUser[uid] = [];
    claimsByUser[uid].push(c);
  }

  const statsMap = {};
  for (const user of users) {
    const uid     = String(user._id);
    const planKey = getUserPlan(user);

    const postCount   = postMap[uid]            || 0;
    const refData     = refMap[uid]             || { total: 0, active: 0 };
    const streakDays  = streakMap[uid]          || 0;
    const userClaims  = claimsByUser[uid]       || [];
    const payoutData  = payoutMap[uid]          || { totalPaid: 0, totalPending: 0, payoutCount: 0 };

    // Claimed slabs with INR values
    const claimedSlabs = userClaims.map(c => ({
      type:         c.type,
      milestone:    c.milestone,
      claimedAt:    c.claimedAt,
      estimatedINR: resolveSlabINR(c.type, planKey, c.milestone),
    }));

    const totalClaimedINR = claimedSlabs.reduce((s, c) => s + c.estimatedINR, 0);

    // In-progress (next unclaimed) slabs
    const inProgress = {
      post:     nextSlabInfo('post',     planKey, postCount,  user.redeemedPostSlabs),
      referral: nextSlabInfo('referral', planKey, refData.active, user.redeemedReferralSlabs),
      streak:   nextSlabInfo('streak',   planKey, streakDays, user.redeemedStreakSlabs),
    };

    statsMap[uid] = {
      planKey,
      posts:        { count: postCount },
      referrals:    { total: refData.total, active: refData.active },
      streaks:      { uniqueDays: streakDays },
      claimedSlabs,
      inProgress,
      wallet: {
        groceryCoupons: user.totalGroceryCoupons || 0,
        shares:         user.totalShares         || 0,
        referralToken:  user.totalReferralToken  || 0,
        estimatedINR:   (user.totalGroceryCoupons || 0)
                      + (user.totalShares || 0)         * SHARE_INR
                      + (user.totalReferralToken || 0)  * TOKEN_INR,
      },
      payouts: {
        paid:     Math.round(payoutData.totalPaid),
        pending:  Math.round(payoutData.totalPending),
        count:    payoutData.payoutCount,
      },
      totalClaimedINR: Math.round(totalClaimedINR),
    };
  }

  return statsMap;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/activity
// ═══════════════════════════════════════════════════════════════════════════
exports.listActivityReport = async (req, res) => {
  try {
    const page   = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 25);
    const skip   = (page - 1) * limit;

    const filter = {};

    // Search: name / email / username / referralId
    if (req.query.search?.trim()) {
      const s = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name:       { $regex: s, $options: 'i' } },
        { email:      { $regex: s, $options: 'i' } },
        { username:   { $regex: s, $options: 'i' } },
        { referralId: { $regex: s, $options: 'i' } },
      ];
    }

    // Plan filter
    if (req.query.plan) {
      const planMap = { '2500': 2500, '3500': 3500, '4500': 4500 };
      const PLAN_NAMES = {
        Basic: 'Basic', Standard: 'Standard', Silver: 'Silver',
        Gold: 'Gold', Premium: 'Premium',
      };
      if (planMap[req.query.plan]) {
        filter['subscription.planAmount'] = planMap[req.query.plan];
      } else if (PLAN_NAMES[req.query.plan]) {
        filter['subscription.plan'] = PLAN_NAMES[req.query.plan];
      }
    }

    // KYC status filter
    if (req.query.kycStatus) {
      filter['kyc.status'] = req.query.kycStatus;
    }

    // Subscription active filter
    if (req.query.subActive === 'true')  filter['subscription.active'] = true;
    if (req.query.subActive === 'false') filter['subscription.active'] = { $ne: true };

    // Date joined range
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = new Date(req.query.from);
      if (req.query.to)   filter.date.$lte = new Date(req.query.to);
    }

    // Always exclude deleted/soft-deleted users
    filter.role = { $ne: 'super_admin' };

    const [users, total] = await Promise.all([
      User.find(filter)
        .select([
          'name email username phone referralId role',
          'subscription kyc date lastActive',
          'totalGroceryCoupons totalShares totalReferralToken',
          'redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs',
          'trustFlags bankDetails',
        ].join(' '))
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const statsMap = await buildUserStats(users);

    const rows = users.map(u => ({
      _id:            String(u._id),
      name:           u.name,
      email:          u.email,
      username:       u.username,
      phone:          u.phone,
      referralId:     u.referralId,
      joinDate:       u.date,
      lastActive:     u.lastActive,
      plan:           u.subscription?.plan     || 'None',
      planAmount:     u.subscription?.planAmount || null,
      subActive:      !!u.subscription?.active,
      subExpires:     u.subscription?.expiresAt || null,
      kycStatus:      u.kyc?.status || 'not_started',
      kycVerifiedAt:  u.kyc?.verifiedAt || null,
      hasBankDetails: !!(u.bankDetails?.accountNumber && u.bankDetails?.ifscCode),
      rewardsFrozen:  !!u.trustFlags?.rewardsFrozen,
      riskTier:       u.trustFlags?.riskTier || 'clean',
      ...statsMap[String(u._id)],
    }));

    return res.json({
      rows,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    });
  } catch (err) {
    console.error('[listActivityReport]', err);
    return res.status(500).json({ message: 'Failed to generate activity report' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/activity/export
// ═══════════════════════════════════════════════════════════════════════════
exports.exportActivityReport = async (req, res) => {
  try {
    const MAX_EXPORT = 5000;

    const filter = {};
    if (req.query.search?.trim()) {
      const s = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name:       { $regex: s, $options: 'i' } },
        { email:      { $regex: s, $options: 'i' } },
        { username:   { $regex: s, $options: 'i' } },
        { referralId: { $regex: s, $options: 'i' } },
      ];
    }
    if (req.query.plan) {
      const planMap = { '2500': 2500, '3500': 3500, '4500': 4500 };
      if (planMap[req.query.plan]) filter['subscription.planAmount'] = planMap[req.query.plan];
    }
    if (req.query.kycStatus)              filter['kyc.status']          = req.query.kycStatus;
    if (req.query.subActive === 'true')   filter['subscription.active'] = true;
    if (req.query.subActive === 'false')  filter['subscription.active'] = { $ne: true };
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = new Date(req.query.from);
      if (req.query.to)   filter.date.$lte = new Date(req.query.to);
    }
    filter.role = { $ne: 'super_admin' };

    const users = await User.find(filter)
      .select([
        'name email username phone referralId',
        'subscription kyc date lastActive',
        'totalGroceryCoupons totalShares totalReferralToken',
        'redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs',
        'trustFlags bankDetails',
      ].join(' '))
      .sort({ date: -1 })
      .limit(MAX_EXPORT)
      .lean();

    const statsMap = await buildUserStats(users);

    // Flatten to CSV-friendly rows
    const rows = users.map(u => {
      const s  = statsMap[String(u._id)] || {};
      const ip = s.inProgress || {};
      return {
        Name:                   u.name,
        Email:                  u.email,
        Username:               u.username,
        Phone:                  u.phone,
        ReferralID:             u.referralId,
        Plan:                   u.subscription?.plan || 'None',
        PlanAmount:             u.subscription?.planAmount || '',
        SubscriptionActive:     u.subscription?.active ? 'Yes' : 'No',
        SubscriptionExpires:    u.subscription?.expiresAt ? new Date(u.subscription.expiresAt).toLocaleDateString() : '',
        KYC_Status:             u.kyc?.status || 'not_started',
        JoinDate:               new Date(u.date).toLocaleDateString(),
        LastActive:             u.lastActive ? new Date(u.lastActive).toLocaleDateString() : '',
        PostCount:              s.posts?.count || 0,
        PostsRedeemedSlabs:     (u.redeemedPostSlabs || []).join('; '),
        PostNextMilestone:      ip.post?.milestone || '',
        PostNextNeeded:         ip.post?.needed || '',
        PostNextINR:            ip.post?.estimatedINR || '',
        ReferralTotal:          s.referrals?.total || 0,
        ReferralActive:         s.referrals?.active || 0,
        ReferralRedeemedSlabs:  (u.redeemedReferralSlabs || []).join('; '),
        ReferralNextMilestone:  ip.referral?.milestone || '',
        ReferralNextNeeded:     ip.referral?.needed || '',
        ReferralNextINR:        ip.referral?.estimatedINR || '',
        StreakDays:             s.streaks?.uniqueDays || 0,
        StreakRedeemedSlabs:    (u.redeemedStreakSlabs || []).join('; '),
        StreakNextMilestone:    ip.streak?.milestone || '',
        StreakNextNeeded:       ip.streak?.needed || '',
        StreakNextINR:          ip.streak?.estimatedINR || '',
        WalletGroceryCoupons:   s.wallet?.groceryCoupons || 0,
        WalletShares:           s.wallet?.shares || 0,
        WalletReferralTokens:   s.wallet?.referralToken || 0,
        WalletEstimatedINR:     s.wallet?.estimatedINR || 0,
        TotalClaimedINR:        s.totalClaimedINR || 0,
        PayoutPaidINR:          s.payouts?.paid || 0,
        PayoutPendingINR:       s.payouts?.pending || 0,
        HasBankDetails:         (u.bankDetails?.accountNumber && u.bankDetails?.ifscCode) ? 'Yes' : 'No',
        RewardsFrozen:          u.trustFlags?.rewardsFrozen ? 'Yes' : 'No',
        RiskTier:               u.trustFlags?.riskTier || 'clean',
      };
    });

    return res.json({ rows, total: rows.length });
  } catch (err) {
    console.error('[exportActivityReport]', err);
    return res.status(500).json({ message: 'Failed to export activity report' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/activity/:userId
// ═══════════════════════════════════════════════════════════════════════════
exports.getUserActivityDetail = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }

    const user = await User.findById(userId)
      .select([
        'name email username phone referralId role',
        'subscription kyc date lastActive',
        'totalGroceryCoupons totalShares totalReferralToken',
        'redeemedPostSlabs redeemedReferralSlabs redeemedStreakSlabs',
        'trustFlags bankDetails',
      ].join(' '))
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });

    const [statsMap, recentPosts, recentActivities] = await Promise.all([
      buildUserStats([user]),
      Posts.find({ user_id: userId, 'moderation.status': { $ne: 'rejected' } })
        .select('post media moderation date')
        .sort({ date: -1 })
        .limit(10)
        .lean(),
      Activity.find({
        $or: [{ user: userId }, { referral: userId }, { userpost: userId }]
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    const stats = statsMap[String(user._id)];

    return res.json({
      user: {
        _id:        String(user._id),
        name:       user.name,
        email:      user.email,
        username:   user.username,
        phone:      user.phone,
        referralId: user.referralId,
        joinDate:   user.date,
        lastActive: user.lastActive,
        subscription: user.subscription,
        kycStatus:  user.kyc?.status || 'not_started',
        kycVerifiedAt: user.kyc?.verifiedAt || null,
        hasBankDetails: !!(user.bankDetails?.accountNumber && user.bankDetails?.ifscCode),
        rewardsFrozen:  !!user.trustFlags?.rewardsFrozen,
        riskTier:       user.trustFlags?.riskTier || 'clean',
        redeemedPostSlabs:     user.redeemedPostSlabs || [],
        redeemedReferralSlabs: user.redeemedReferralSlabs || [],
        redeemedStreakSlabs:   user.redeemedStreakSlabs || [],
      },
      stats,
      recentPosts,
      recentActivities,
    });
  } catch (err) {
    console.error('[getUserActivityDetail]', err);
    return res.status(500).json({ message: 'Failed to fetch user activity detail' });
  }
};