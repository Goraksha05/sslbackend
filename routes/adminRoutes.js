// routes/adminRoutes.js
// All original endpoints kept intact.
//
// ── NEW in this version ──────────────────────────────────────────────────────
//   POST /api/admin/ban-user/:id    — ban a user (super_admin or admin with ban_users)
//   POST /api/admin/unban-user/:id  — lift a ban  (same permission requirement)
//
//   GET  /api/admin/reports/activity          — paginated per-user activity report
//   GET  /api/admin/reports/activity/export   — full export (≤5000 rows, no pagination)
//   GET  /api/admin/reports/activity/:userId  — single-user activity detail
//
// Permission model:
//   • super_admin       — always allowed (wildcard '*' from fetchUser middleware)
//   • admin with role   — allowed only if 'ban_users' / 'view_reports' is in their permissions[]
//   • admin without it  — 403 Forbidden
//
// ROUTE ORDERING NOTE:
//   /reports/activity/export must be registered BEFORE /reports/activity/:userId
//   so Express does not treat "export" as a userId param.
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

// ── NEW: activity report controller ──────────────────────────────────────────
const activityReport = require('../controllers/adminActivityReportController');

// Convenience alias — keeps all existing route files that imported `isAdmin`
// working without touching them.
const isAdmin = verifyAdmin;

// ════════════════════════════════════════════════════════════════════════════
// EXISTING ROUTES (unchanged)
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

    const { undoReward } = require('../services/RewardEngine');

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
      _id:                   user._id,
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
      // Include ban status so the frontend can render the correct button state
      banned:                !!(user.banned?.isBanned),
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
    // FIX: RewardClaim schema declares ref: 'User' (capital U) but User.js
    // registers the model as mongoose.model('user', ...) (lowercase).
    // Mongoose's populate() looks up the registered model by the ref string
    // and throws "Schema hasn't been registered for model 'User'" when the
    // casing doesn't match.
    //
    // Using the { model, select } object form of populate() overrides the ref
    // and explicitly passes the already-loaded User constructor, so the casing
    // in the RewardClaim schema is irrelevant.
    const claims = await RewardClaim.find()
      .populate({ path: 'user', model: User, select: 'name email' })
      .sort({ claimedAt: -1 });
    res.json(claims);
  } catch (err) {
    console.error('Reward claim fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reward claims' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// NEW: CREATE ADMIN ACCOUNT  (super_admin only)
// ════════════════════════════════════════════════════════════════════════════

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
// PERMISSIONS CATALOGUE
// ════════════════════════════════════════════════════════════════════════════

const { PERMISSIONS, ROLE_PRESETS } = require('../constants/permissions');

router.get('/permissions', fetchUser, verifySuperAdmin, (req, res) => {
  res.json({ permissions: Object.values(PERMISSIONS), presets: ROLE_PRESETS });
});

// ════════════════════════════════════════════════════════════════════════════
// CURRENT ADMIN PROFILE
// ════════════════════════════════════════════════════════════════════════════

router.get('/me', fetchUser, isAdmin, mgmt.getMe);

// ════════════════════════════════════════════════════════════════════════════
// FINANCIAL ANALYTICS
// ════════════════════════════════════════════════════════════════════════════

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
    return res.json({ totals: { users: totalUsers, activeSubs }, subPlans });
  } catch (err) {
    console.error('[GET /analytics]', err);
    return res.status(500).json({ message: 'Failed to fetch analytics' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FINANCIAL REPORT
// ════════════════════════════════════════════════════════════════════════════

router.get('/reports/financial', fetchUser, isAdmin, checkPermission('view_reports'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.plan) filter['subscription.plan'] = req.query.plan;
    if (req.query.hasBankDetails === 'true') {
      filter['bankDetails.accountNumber'] = { $exists: true, $ne: null };
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
      panNumber:     u.bankDetails?.panNumber     || 'N/A',
    }));

    return res.json({ report, pagination: { page, pages: Math.ceil(total / limit), total, limit } });
  } catch (err) {
    console.error('[GET /reports/financial]', err);
    return res.status(500).json({ message: 'Failed to fetch financial report' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ACTIVITY REPORTS  ← NEW
// ════════════════════════════════════════════════════════════════════════════
//
// All three routes share the same permission: 'view_reports'.
//
// ORDERING IS CRITICAL:
//   /reports/activity/export  must be declared BEFORE /reports/activity/:userId
//   so Express matches the literal string "export" as a path segment, not as
//   a value for the :userId param.
//
// GET /api/admin/reports/activity
//   Paginated list with per-user post/referral/streak/wallet stats.
//   Query params: page, limit, search, plan, kycStatus, subActive, from, to
//
// GET /api/admin/reports/activity/export
//   Full export without pagination (max 5000 rows).
//   Same query params as the list endpoint, no page/limit.
//
// GET /api/admin/reports/activity/:userId
//   Complete activity detail for a single user — used by the admin detail drawer.
//
router.get(
  '/reports/activity/export',
  fetchUser,
  isAdmin,
  checkPermission('view_reports'),
  activityReport.exportActivityReport
);

router.get(
  '/reports/activity/:userId',
  fetchUser,
  isAdmin,
  checkPermission('view_reports'),
  activityReport.getUserActivityDetail
);

router.get(
  '/reports/activity',
  fetchUser,
  isAdmin,
  checkPermission('view_reports'),
  activityReport.listActivityReport
);

// ════════════════════════════════════════════════════════════════════════════
// USER BAN / UNBAN
// ════════════════════════════════════════════════════════════════════════════
//
// Permission: 'ban_users'
//   • super_admin — always allowed (wildcard '*' granted by fetchUser middleware)
//   • admin       — allowed only if their assigned AdminRole includes 'ban_users'
//
// Why checkPermission('ban_users') instead of verifySuperAdmin:
//   verifySuperAdmin would lock these endpoints to super_admins only and
//   prevent delegated admins whose role explicitly includes 'ban_users' from
//   using the feature. checkPermission handles both cases correctly:
//     isSuperAdmin → true  (via '*' wildcard in permissions[])
//     permissions.includes('ban_users') → true for delegated admins
//
// POST /api/admin/ban-user/:id
//   Body (optional): { reason: string }
//   Response:        { message, user: { id, name, email, banned } }
//
router.post(
  '/ban-user/:id',
  fetchUser,
  isAdmin,
  checkPermission('ban_users'),
  async (req, res) => {
    const { id } = req.params;
    const reason  = (req.body?.reason || '').trim().slice(0, 500) || null;

    try {
      const target = await User.findById(id);

      if (!target) {
        return res.status(404).json({ message: 'User not found.' });
      }

      // Prevent banning admins / super_admins through this endpoint
      if (target.role === 'admin' || target.role === 'super_admin') {
        return res.status(403).json({
          message: 'Admin accounts cannot be banned through this endpoint. Use the admin management panel.',
        });
      }

      // Prevent banning an already-banned user (idempotency)
      if (target.banned?.isBanned) {
        return res.status(409).json({ message: 'User is already banned.' });
      }

      // Write the ban sub-document
      target.banned = {
        isBanned:  true,
        reason:    reason,
        bannedAt:  new Date(),
        bannedBy:  req.user.id,
      };

      await target.save();

      // Audit trail
      await writeAudit(req, 'user_ban', {
        targetId:    target._id,
        targetEmail: target.email,
        reason,
      });

      return res.status(200).json({
        message: `${target.name} (${target.email}) has been banned.`,
        user: {
          id:     target._id,
          name:   target.name,
          email:  target.email,
          banned: true,
        },
      });
    } catch (err) {
      console.error('[POST /ban-user/:id]', err);
      return res.status(500).json({ message: 'Failed to ban user.' });
    }
  }
);

//
// POST /api/admin/unban-user/:id
//   Response: { message, user: { id, name, email, banned } }
//
router.post(
  '/unban-user/:id',
  fetchUser,
  isAdmin,
  checkPermission('ban_users'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const target = await User.findById(id);

      if (!target) {
        return res.status(404).json({ message: 'User not found.' });
      }

      // Idempotency: already unbanned
      if (!target.banned?.isBanned) {
        return res.status(409).json({ message: 'User is not currently banned.' });
      }

      // Clear the ban
      target.banned = {
        isBanned:    false,
        reason:      null,
        bannedAt:    null,
        bannedBy:    null,
        unbannedAt:  new Date(),
        unbannedBy:  req.user.id,
      };

      await target.save();

      // Audit trail
      await writeAudit(req, 'user_unban', {
        targetId:    target._id,
        targetEmail: target.email,
      });

      return res.status(200).json({
        message: `${target.name} (${target.email}) has been unbanned.`,
        user: {
          id:     target._id,
          name:   target.name,
          email:  target.email,
          banned: false,
        },
      });
    } catch (err) {
      console.error('[POST /unban-user/:id]', err);
      return res.status(500).json({ message: 'Failed to unban user.' });
    }
  }
);

module.exports = router;