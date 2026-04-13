/**
 * routes/walletReportRoutes.js
 *
 * Mounted inside the protected adminRouter in index.js:
 *   adminRouter.use(require('./routes/walletReportRoutes'));
 *
 * Routes:
 *   GET /api/admin/wallet-report          — paginated user-wise wallet table
 *   GET /api/admin/wallet-report/export   — full export (max 5 000 rows, no pagination)
 *
 * Required permissions:
 *   view_reports   — read access (both routes)
 *   manage_payouts — write access (Pay button calls existing /payouts/process)
 *
 * Data returned per user:
 *   groceryCoupons  — ₹ cash value (totalGroceryCoupons on User model)
 *   shares          — unit count   (totalShares)
 *   referralToken   — unit count   (totalReferralToken)
 *   pendingClaimIds — array of RewardClaim _ids whose grocery-coupon portion
 *                     has not yet been paid out; consumed by the Pay button on
 *                     the frontend which calls POST /api/admin/payouts/process
 *                     (or /bulk-process) for each id.
 *
 * MOUNT in index.js (inside the protected adminRouter block):
 *   adminRouter.use(require('./routes/walletReportRoutes'));
 */

'use strict';

const express       = require('express');
const router        = express.Router();
const mongoose      = require('mongoose');
const { checkPermission } = require('../middleware/rbac');
const User          = require('../models/User');
const RewardClaim   = require('../models/RewardClaim');
const Payout        = require('../models/PayoutSchema');

const requireView = checkPermission('view_reports');

// ── Shared query builder ──────────────────────────────────────────────────────
function buildFilter(query) {
  const filter = { role: { $ne: 'super_admin' } };

  if (query.search?.trim()) {
    const s = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name:     { $regex: s, $options: 'i' } },
      { email:    { $regex: s, $options: 'i' } },
      { username: { $regex: s, $options: 'i' } },
    ];
  }

  // hasEarnings — only show users with at least one reward
  if (query.hasEarnings === 'true') {
    filter.$or = filter.$or
      ? filter.$or
      : undefined;
    filter.$and = [
      {
        $or: [
          { totalGroceryCoupons: { $gt: 0 } },
          { totalShares:         { $gt: 0 } },
          { totalReferralToken:  { $gt: 0 } },
        ],
      },
    ];
  }

  return filter;
}

// ── Enrich users with pending claim ids ───────────────────────────────────────
async function enrichWithPendingClaims(users) {
  if (!users.length) return {};

  const userIds = users.map(u => u._id);

  // All unpaid claims for these users — a claim is "paid" when a Payout
  // document with status 'paid' or 'processing' references it.
  const allClaims = await RewardClaim.find({ user: { $in: userIds } })
    .select('_id user')
    .lean();

  if (!allClaims.length) return {};

  const claimIds = allClaims.map(c => c._id);

  // Find which claims already have a non-failed payout
  const existingPayouts = await Payout.find({
    rewardClaim: { $in: claimIds },
    status: { $in: ['pending', 'processing', 'paid', 'on_hold'] },
  })
    .select('rewardClaim')
    .lean();

  const paidClaimIdSet = new Set(
    existingPayouts.map(p => String(p.rewardClaim))
  );

  // Group unpaid claim ids by user
  const map = {};
  for (const c of allClaims) {
    const uid = String(c.user);
    if (!map[uid]) map[uid] = [];
    if (!paidClaimIdSet.has(String(c._id))) {
      map[uid].push(String(c._id));
    }
  }

  return map;
}

// ── GET /api/admin/wallet-report ──────────────────────────────────────────────
router.get('/wallet-report', requireView, async (req, res) => {
  try {
    const page  = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    const filter = buildFilter(req.query);

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('name email username phone referralId subscription kyc bankDetails totalGroceryCoupons totalShares totalReferralToken lastActive date')
        .sort({ totalGroceryCoupons: -1, totalShares: -1 })   // highest earners first
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const pendingMap = await enrichWithPendingClaims(users);

    const rows = users.map(u => ({
      _id:            String(u._id),
      name:           u.name,
      email:          u.email,
      username:       u.username,
      phone:          u.phone || '—',
      referralId:     u.referralId || '—',
      plan:           u.subscription?.plan     || 'None',
      planAmount:     u.subscription?.planAmount || null,
      subActive:      !!u.subscription?.active,
      kycStatus:      u.kyc?.status || 'not_started',
      hasBankDetails: !!(u.bankDetails?.accountNumber && u.bankDetails?.ifscCode),
      lastActive:     u.lastActive || null,
      joinDate:       u.date || null,
      // Wallet fields
      groceryCoupons: u.totalGroceryCoupons || 0,   // ₹ cash
      shares:         u.totalShares         || 0,   // unit count
      referralToken:  u.totalReferralToken  || 0,   // unit count
      // Pending claim ids for the Pay button
      pendingClaimIds: pendingMap[String(u._id)] || [],
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
    console.error('[walletReport]', err);
    return res.status(500).json({ message: 'Failed to fetch wallet report' });
  }
});

// ── GET /api/admin/wallet-report/export ───────────────────────────────────────
// Returns up to 5 000 rows with no pagination — used for Excel / PDF download.
router.get('/wallet-report/export', requireView, async (req, res) => {
  try {
    const MAX = 5000;
    const filter = buildFilter(req.query);

    const users = await User.find(filter)
      .select('name email username phone referralId subscription kyc bankDetails totalGroceryCoupons totalShares totalReferralToken lastActive date')
      .sort({ totalGroceryCoupons: -1, totalShares: -1 })
      .limit(MAX)
      .lean();

    const pendingMap = await enrichWithPendingClaims(users);

    const rows = users.map(u => ({
      Name:              u.name,
      Email:             u.email,
      Username:          u.username,
      Phone:             u.phone || '',
      ReferralID:        u.referralId || '',
      Plan:              u.subscription?.plan     || 'None',
      PlanAmount:        u.subscription?.planAmount || '',
      SubscriptionActive: u.subscription?.active ? 'Yes' : 'No',
      KYC:               u.kyc?.status || 'not_started',
      BankDetails:       (u.bankDetails?.accountNumber && u.bankDetails?.ifscCode) ? 'Yes' : 'No',
      'Grocery Coupons (₹)': u.totalGroceryCoupons || 0,
      'Shares (units)':       u.totalShares         || 0,
      'Referral Tokens':      u.totalReferralToken  || 0,
      'Pending Claims':  (pendingMap[String(u._id)] || []).length,
      JoinDate:          u.date        ? new Date(u.date).toLocaleDateString('en-IN')       : '',
      LastActive:        u.lastActive  ? new Date(u.lastActive).toLocaleDateString('en-IN') : '',
    }));

    return res.json({ rows, total: rows.length });
  } catch (err) {
    console.error('[walletReport/export]', err);
    return res.status(500).json({ message: 'Failed to export wallet report' });
  }
});

module.exports = router;