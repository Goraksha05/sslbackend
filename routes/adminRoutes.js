// routes/adminRoutes.js
// All original endpoints kept intact; each carries the appropriate
// checkPermission() guard alongside the existing fetchUser + isAdmin chain.
// Admin-management, role-management and audit-log endpoints wired.
//
// ── NEW in this version ──────────────────────────────────────────────────────
//   POST /create-admin  — super_admin creates a brand-new admin account
//                         (replaces the old /register dual-mode approach).
//                         Called by AdminCreateUser.js (post-login only).
// ─────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const router     = express.Router();
const Activity   = require('../models/Activity');
const User       = require('../models/User');
const fetchUser  = require('../middleware/fetchuser');
const { verifyAdmin, verifySuperAdmin, checkPermission, writeAudit } = require('../middleware/rbac');
const { undoRedemption } = require('../utils/undoRewardRedemption');
const RewardClaim = require('../models/RewardClaim');
const mgmt       = require('../controllers/adminManagementController');

// Convenience alias — keeps all existing route files that imported `isAdmin`
// working without touching them.
const isAdmin = verifyAdmin;

// ════════════════════════════════════════════════════════════════════════════
// EXISTING ROUTES (unchanged behaviour, permission guard added)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users
router.get('/users', fetchUser, isAdmin, checkPermission('view_users'), async (req, res) => {
  try {
    const users = await User.find().select('name email').lean();
    res.status(200).json({ users });
  } catch (err) {
    console.error('Admin fetch users error:', err);
    res.status(500).json({ message: 'Failed to load users' });
  }
});

// GET /api/admin/rewards
router.get('/rewards', fetchUser, isAdmin, checkPermission('view_rewards'), async (req, res) => {
  try {
    const referralRewards = await Activity.find({ referral:   { $exists: true }, slabAwarded: { $exists: true } }).populate('user');
    const postRewards     = await Activity.find({ userpost:   { $exists: true }, slabAwarded: { $exists: true } }).populate('user');
    const streakRewards   = await Activity.find({ streakslab: { $exists: true } }).populate('user');
    res.status(200).json({ referralRewards, postRewards, streakRewards });
  } catch (err) {
    console.error('Admin rewards fetch error:', err);
    res.status(500).json({ message: 'Failed to fetch rewards for admin' });
  }
});

// POST /api/admin/admin/undo-reward
router.post('/admin/undo-reward', fetchUser, isAdmin, checkPermission('undo_rewards'), async (req, res) => {
  try {
    const { userId, type, slab } = req.body;
 
    if (!userId || !type || slab == null) {
      return res.status(400).json({ message: 'userId, type, and slab are required.' });
    }
 
    const { undoReward, RewardEngineError } = require('../services/RewardEngine');
 
    const success = await undoReward(userId, type, slab);
 
    if (!success) {
      return res.status(400).json({ message: 'Nothing to undo — slab not found in redeemed list.' });
    }
 
    await writeAudit(req, 'reward_undo', { targetId: userId, type, slab });
    return res.status(200).json({ message: 'Redemption undone successfully.' });
 
  } catch (err) {
    if (err.name === 'RewardEngineError') {
      return res.status(err.status || 400).json({ message: err.message, code: err.code });
    }
    console.error('[POST /admin/undo-reward]', err);
    return res.status(500).json({ message: 'Failed to undo reward redemption.' });
  }
});

// GET /api/admin/user-report
router.get('/user-report', fetchUser, isAdmin, checkPermission('view_reports'), async (req, res) => {
  try {
    const users = await User.find().select('-password').lean();
    const formatDate = (date) => {
      if (!date) return 'N/A';
      const d = new Date(date);
      return isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString();
    };
    const report = users.map(user => ({
      name:                  user.name,
      email:                 user.email,
      phone:                 user.phone,
      username:              user.username,
      subscription:          user.subscription?.plan || 'None',
      subscriptionActive:    user.subscription?.active ? 'Yes' : 'No',
      subscriptionStart:     formatDate(user.subscription?.startDate),
      subscriptionExpiry:    formatDate(user.subscription?.expiresAt),
      lastActive:            formatDate(user.lastActive),
      referralTokens:        user.totalReferralToken || 0,
      postMilestoneSlabs:    user.rewardedPostMilestones?.length || 0,
      redeemedPostSlabs:     user.redeemedPostSlabs?.length || 0,
      redeemedReferralSlabs: user.redeemedReferralSlabs?.length || 0,
      redeemedStreakSlabs:   user.redeemedStreakSlabs?.length || 0,
    }));
    res.status(200).json({ success: true, report });
  } catch (err) {
    console.error('User report generation error:', err);
    res.status(500).json({ success: false, message: 'Error generating report' });
  }
});

// GET /api/admin/reward-claims
router.get('/reward-claims', fetchUser, isAdmin, checkPermission('approve_reward_claims'), async (req, res) => {
  try {
    const claims = await RewardClaim.find().populate('user', 'name email').sort({ claimedAt: -1 });
    res.json(claims);
  } catch (err) {
    console.error('Reward claim fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reward claims' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// NEW: CREATE ADMIN ACCOUNT  (super_admin only)
// ════════════════════════════════════════════════════════════════════════════
//
// POST /api/admin/create-admin
//
// Called by: AdminCreateUser.js (pages/AdminCreateUser.js) — only after
// super_admin is logged in and navigates to /admin/create-admin.
//
// Body: { name, username, email, phone, password, roleId, permissions? }
//
// What makes this different from POST /api/auth/createuser:
//   ✅ No referral code required — internal accounts are exempt
//   ✅ No OTP verification       — super_admin is trusted
//   ✅ Sets role:'admin', isAdmin:true, adminRole immediately
//   ✅ Optional per-permission override via `permissions[]`
//   ✅ Does NOT log the new admin in — they log in separately
//   ✅ Writes an audit log entry

router.post('/create-admin', fetchUser, verifySuperAdmin, mgmt.createAdmin);

// ════════════════════════════════════════════════════════════════════════════
// ADMIN MANAGEMENT  (super_admin only for create/delete/role-change)
// ════════════════════════════════════════════════════════════════════════════

router.get(   '/admins',          fetchUser, isAdmin,         checkPermission('manage_admins'), mgmt.listAdmins);
router.post(  '/admins',          fetchUser, verifySuperAdmin,                                  mgmt.promoteAdmin);
router.put(   '/admins/:id/role', fetchUser, verifySuperAdmin,                                  mgmt.changeAdminRole);
router.delete('/admins/:id',      fetchUser, verifySuperAdmin,                                  mgmt.demoteAdmin);

// ════════════════════════════════════════════════════════════════════════════
// ROLE MANAGEMENT  (super_admin only)
// ════════════════════════════════════════════════════════════════════════════

router.get(   '/roles',     fetchUser, verifySuperAdmin, mgmt.listRoles);
router.post(  '/roles',     fetchUser, verifySuperAdmin, mgmt.createRole);
router.put(   '/roles/:id', fetchUser, verifySuperAdmin, mgmt.updateRole);
router.delete('/roles/:id', fetchUser, verifySuperAdmin, mgmt.deleteRole);

// ════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ════════════════════════════════════════════════════════════════════════════

router.get('/audit-logs', fetchUser, isAdmin, checkPermission('view_audit_logs'), mgmt.getAuditLogs);

// ════════════════════════════════════════════════════════════════════════════
// PERMISSIONS CATALOGUE  (so frontend can build role-creation UI)
// ════════════════════════════════════════════════════════════════════════════

const { PERMISSIONS, ROLE_PRESETS } = require('../constants/permissions');

router.get('/permissions', fetchUser, verifySuperAdmin, (req, res) => {
  res.json({ permissions: Object.values(PERMISSIONS), presets: ROLE_PRESETS });
});

// ════════════════════════════════════════════════════════════════════════════
// CURRENT ADMIN PROFILE  (any admin can call this)
// ════════════════════════════════════════════════════════════════════════════

router.get('/me', fetchUser, isAdmin, mgmt.getMe);

// ════════════════════════════════════════════════════════════════════════════
// FINANCIAL ANALYTICS  (used by AdminFinancial.js dashboard)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/analytics
router.get('/analytics', fetchUser, isAdmin, checkPermission('view_reports'), async (req, res) => {
  try {
    const now = new Date();

    const [totalUsers, activeSubs, subPlans] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ 'subscription.active': true, 'subscription.expiresAt': { $gt: now } }),
      User.aggregate([
        { $match: { 'subscription.plan': { $exists: true, $ne: null } } },
        { $group: { _id: '$subscription.plan', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    return res.json({
      totals: {
        users:      totalUsers,
        activeSubs,
      },
      subPlans, // [{ _id: 'Gold', count: 42 }, ...]
    });
  } catch (err) {
    console.error('[GET /analytics]', err);
    return res.status(500).json({ message: 'Failed to fetch analytics' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FINANCIAL REPORT  (paginated user subscription + bank details)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/reports/financial
router.get('/reports/financial', fetchUser, isAdmin, checkPermission('view_reports'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    const filter = {};

    if (req.query.plan)           filter['subscription.plan']   = req.query.plan;
    if (req.query.hasBankDetails === 'true') {
      filter['bankDetails.accountNumber'] = { $exists: true, $ne: null, $ne: '' };
    }
    if (req.query.from || req.query.to) {
      filter['subscription.startDate'] = {};
      if (req.query.from) filter['subscription.startDate'].$gte = new Date(req.query.from);
      if (req.query.to)   filter['subscription.startDate'].$lte = new Date(req.query.to);
    }

    const formatDate = d => (d ? new Date(d).toLocaleDateString() : 'N/A');

    const [users, total] = await Promise.all([
      User.find(filter).select('-password').lean().skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    const report = users.map(u => ({
      name:          u.name,
      email:         u.email,
      phone:         u.phone,
      plan:          u.subscription?.plan   || 'None',
      active:        u.subscription?.active ? 'Yes' : 'No',
      startDate:     formatDate(u.subscription?.startDate),
      expiresAt:     formatDate(u.subscription?.expiresAt),
      paymentId:     u.subscription?.paymentId   || 'N/A',
      accountNumber: u.bankDetails?.accountNumber || 'N/A',
      ifscCode:      u.bankDetails?.ifscCode      || 'N/A',
      panNumber:     u.bankDetails?.panNumber      || 'N/A',
    }));

    return res.json({
      report,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    });
  } catch (err) {
    console.error('[GET /reports/financial]', err);
    return res.status(500).json({ message: 'Failed to fetch financial report' });
  }
});

module.exports = router;