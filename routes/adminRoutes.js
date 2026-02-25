// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const User = require('../models/User');
const fetchUser = require('../middleware/fetchuser');
const isAdmin = require('../middleware/isAdmin');
const { undoRedemption } = require('../utils/undoRewardRedemption');
const RewardClaim = require('../models/RewardClaim');


// Middleware to restrict access to admins (adjust as needed)
// const isAdmin = async (req, res, next) => {
//   const user = await User.findById(req.user.id);
//   if (user?.role !== 'admin') {
//     return res.status(403).json({ message: 'Admin access required.' });
//   }
//   next();
// };

// GET /api/admin/users
router.get('/users', fetchUser, isAdmin, async (req, res) => {
  try {
    const users = await User.find().select('name email');
    res.status(200).json({ users });
  } catch (err) {
    console.error('Admin fetch users error:', err);
    res.status(500).json({ message: 'Failed to load users' });
  }
});


// GET /api/admin/rewards
router.get('/rewards', fetchUser, isAdmin, async (req, res) => {
  try {
    const referralRewards = await Activity.find({ referral: { $exists: true }, slabAwarded: { $exists: true } }).populate('user');
    const postRewards = await Activity.find({ userpost: { $exists: true }, slabAwarded: { $exists: true } }).populate('user');
    const streakRewards = await Activity.find({ streakslab: { $exists: true } }).populate('user');

    res.status(200).json({
      referralRewards,
      postRewards,
      streakRewards,
    });
  } catch (err) {
    console.error('Admin rewards fetch error:', err);
    res.status(500).json({ message: 'Failed to fetch rewards for admin' });
  }
});

// POST /api/activity/admin/undo-reward
router.post('/admin/undo-reward', fetchUser, isAdmin, async (req, res) => {
  try {
    const { userId, type, slab } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const success = await undoRedemption(user, type, slab);

    if (!success) {
      return res.status(400).json({ message: 'Nothing to undo or invalid slab type' });
    }

    return res.status(200).json({ message: 'Redemption undone successfully' });
  } catch (err) {
    console.error('[POST /admin/undo-reward]', err);
    res.status(500).json({ message: 'Failed to undo reward redemption' });
  }
});

router.get('/user-report', fetchUser, isAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').lean(); // lean for plain objects

    const formatDate = (date) => {
      if (!date) return 'N/A';
      const d = new Date(date);
      return isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString(); // format to readable date
    };

    const report = users.map(user => ({
      name: user.name,
      email: user.email,
      phone: user.phone,
      username: user.username,
      subscription: user.subscription?.plan || 'None',
      subscriptionActive: user.subscription?.active ? 'Yes' : 'No',
      subscriptionStart: formatDate(user.subscription?.startDate),
      subscriptionExpiry: formatDate(user.subscription?.expiresAt),
      lastActive: formatDate(user.lastActive),
      referralTokens: user.totalReferralToken || 0,
      postMilestoneSlabs: user.rewardedPostMilestones?.length || 0,
      redeemedPostSlabs: user.redeemedPostSlabs?.length || 0,
      redeemedReferralSlabs: user.redeemedReferralSlabs?.length || 0,
      redeemedStreakSlabs: user.redeemedStreakSlabs?.length || 0,
    }));

    res.status(200).json({ success: true, report });
  } catch (err) {
    console.error('User report generation error:', err);
    res.status(500).json({ success: false, message: 'Error generating report' });
  }
});

router.get("/reward-claims", fetchUser, isAdmin, async (req, res) => {
  try {
    const claims = await RewardClaim.find()
      .populate("user", "name email") // only fetch user name & email
      .sort({ claimedAt: -1 }); // newest first
    res.json(claims);
  } catch (err) {
    console.error("Reward claim fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch reward claims" });
  }
});


module.exports = router;
