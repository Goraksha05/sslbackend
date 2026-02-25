const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const User = require('../models/User');
const PostsSchema = require('../models/Posts');
const fetchUser = require('../middleware/fetchuser');

const { calculateReferralReward } = require('../utils/tierCalculation/calculateReferralReward');
const { calculatePostsReward } = require('../utils/tierCalculation/calculatePostsReward');
const { calculateStreakReward } = require('../utils/tierCalculation/calculateStreakReward');

const Notification = require('../models/Notification');
const RewardClaim = require('../models/RewardClaim');

const { getIO } = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser = require('../utils/notifyUser');
const { getCommunityCount } = require('../utils/communityUtils');

/* ------------------------------------------------------------------
   Helpers
-------------------------------------------------------------------*/

// Map subscription.plan → reward-file key
function planKeyFromUser(user) {
  // adjust this map to your real plan names if needed
  const map = { Basic: '2500', Silver: '3500', Gold: '4500' };
  return map[user.subscription?.plan] || '2500';
}

// merge bank details into user instance (no separate save)
function mergeBankDetails(user, bankDetails) {
  if (!bankDetails) return;
  user.bankDetails = {
    accountNumber: bankDetails.accountNumber || user.bankDetails?.accountNumber,
    ifscCode: bankDetails.ifscCode || user.bankDetails?.ifscCode,
    panNumber: bankDetails.panNumber || user.bankDetails?.panNumber
  };
}

// send a socket / push / db notification
async function notifyAndPush(userId, type, message, url) {
  await Notification.create({ user: userId, sender: userId, type, message, url });
  await notifyUser(userId, message, type);
  sendPushToUser(userId, { title: message.split('!')[0], message, url });
  getIO().to(userId.toString()).emit('notification', { type, from: userId, message });
}

/* ------------------------------------------------------------------
   Referral Reward
-------------------------------------------------------------------*/
router.post('/referral', fetchUser, async (req, res) => {
  try {
    const { referralCount, bankDetails } = req.body;
    const count = Number(referralCount);
    if (!count || isNaN(count)) {
      return res.status(400).json({ message: 'Invalid referral count provided' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.subscription?.active) {
      return res.status(403).json({ message: 'Subscription required before claim reward' });
    }

    const referred = await User.find({ referral: user._id, 'subscription.active': true });
    if (referred.length < count) {
      return res.status(400).json({ message: 'You have not reached this milestone yet.' });
    }

    if (user.redeemedReferralSlabs?.includes(count)) {
      return res.status(409).json({ message: 'Reward already claimed for this milestone.' });
    }

    const reward = calculateReferralReward(count, planKeyFromUser(user));
    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = reward;

    await new Activity({ user: user._id, referral: user._id, type: 'referral_reward', slabAwarded: count }).save();
    await RewardClaim.create({ user: user._id, type: 'referral', milestone: count });

    user.redeemedReferralSlabs.push(count);
    user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + groceryCoupons;
    user.totalShares        = (user.totalShares || 0) + shares;
    user.totalReferralToken = (user.totalReferralToken || 0) + referralToken;

    mergeBankDetails(user, bankDetails);
    await user.save();

    await notifyAndPush(user._id, 'referral_reward',
      `You claimed referral reward for ${count} referrals! 🎉`, '/rewards/referral');

    res.status(200).json({
      message: 'Referral reward claimed!',
      reward,
      totals: {
        totalGroceryCoupons: user.totalGroceryCoupons,
        totalShares: user.totalShares,
        totalReferralToken: user.totalReferralToken,
        redeemedReferralSlabs: user.redeemedReferralSlabs
      }
    });
  } catch (err) {
    console.error('Referral reward error:', err);
    res.status(500).json({ message: 'Server error during referral reward claim' });
  }
});

/* ------------------------------------------------------------------
   Invited list
-------------------------------------------------------------------*/
router.get('/invited/:referralId', fetchUser, async (req, res) => {
  try {
    const inviter = await User.findOne({ referralId: req.params.referralId });
    if (!inviter) return res.status(404).json([]);
    const invited = await User.find({ referral: inviter._id }).select('name subscription');
    res.json(invited);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

/* ------------------------------------------------------------------
   Post Reward
-------------------------------------------------------------------*/
router.post('/post-reward', fetchUser, async (req, res) => {
  try {
    const { postreward, bankDetails } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.subscription?.active) {
      return res.status(403).json({ message: 'Subscription required before claim reward' });
    }

    const postCount = await PostsSchema.countDocuments({ user_id: user._id });
    if (postCount < postreward) {
      return res.status(400).json({ message: 'You have not reached this milestone yet.' });
    }
    if (user.redeemedPostSlabs?.includes(postreward)) {
      return res.status(409).json({ message: 'Reward already claimed' });
    }

    const reward = calculatePostsReward(postCount, planKeyFromUser(user));
    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = reward;

    await new Activity({ userpost: user._id, slabAwarded: postreward, user: user._id }).save();
    await RewardClaim.create({ user: user._id, type: 'post', milestone: postreward });

    user.redeemedPostSlabs.push(postreward);
    user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + groceryCoupons;
    user.totalShares        = (user.totalShares || 0) + shares;
    user.totalReferralToken = (user.totalReferralToken || 0) + referralToken;

    mergeBankDetails(user, bankDetails);
    await user.save();

    await notifyAndPush(user._id, 'post_reward',
      `You claimed a post reward for ${postreward} posts! 🚀`, '/rewards/posts');

    res.status(200).json({
      message: 'Post reward claimed',
      reward,
      totals: {
        totalGroceryCoupons: user.totalGroceryCoupons,
        totalShares: user.totalShares,
        totalReferralToken: user.totalReferralToken,
        redeemedPostSlabs: user.redeemedPostSlabs
      }
    });
  } catch (err) {
    console.error('Post reward error:', err);
    res.status(500).json({ message: 'Server error during post reward claim' });
  }
});

/* ------------------------------------------------------------------
   Streak Reward
-------------------------------------------------------------------*/
router.post('/streak-reward', fetchUser, async (req, res) => {
  try {
    let { streakslab, bankDetails } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.subscription?.active) {
      return res.status(403).json({ message: 'Subscription required before claim reward' });
    }

    const daysRequired = Number(
      typeof streakslab === 'string' ? streakslab.replace('days', '') : streakslab
    );
    if (!daysRequired || isNaN(daysRequired)) {
      return res.status(400).json({ message: 'Invalid streak milestone' });
    }
    const slabKey = `${daysRequired}days`;

    const streakCount = await Activity.countDocuments({
      user: user._id,
      dailystreak: { $exists: true }
    });
    if (streakCount < daysRequired) {
      return res.status(400).json({ message: 'You have not reached this milestone yet.' });
    }
    if (!Array.isArray(user.redeemedStreakSlabs)) user.redeemedStreakSlabs = [];
    if (user.redeemedStreakSlabs.includes(slabKey)) {
      return res.status(409).json({ message: 'Reward already claimed' });
    }

    const reward = calculateStreakReward(daysRequired, planKeyFromUser(user));
    if (!reward) return res.status(404).json({ message: 'Reward configuration not found' });

    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = reward;

    await new Activity({ streakslab: slabKey, user: user._id }).save();
    await RewardClaim.create({ user: user._id, type: 'streak', milestone: slabKey });

    user.redeemedStreakSlabs.push(slabKey);
    user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + groceryCoupons;
    user.totalShares        = (user.totalShares || 0) + shares;
    user.totalReferralToken = (user.totalReferralToken || 0) + referralToken;

    mergeBankDetails(user, bankDetails);
    await user.save();

    await notifyAndPush(user._id, 'streak_reward',
      `You claimed a streak reward for ${daysRequired} days! 🔥`, '/rewards/streaks');

    res.status(200).json({
      message: 'Streak reward claimed!',
      reward,
      totals: {
        totalGroceryCoupons: user.totalGroceryCoupons,
        totalShares: user.totalShares,
        totalReferralToken: user.totalReferralToken,
        redeemedStreakSlabs: user.redeemedStreakSlabs
      }
    });
  } catch (err) {
    console.error('Streak reward error stack:', err);
    res.status(500).json({ message: err.message || 'Server error during streak reward claim' });
  }
});

/* ------------------------------------------------------------------
   Daily streak logging
-------------------------------------------------------------------*/
router.post('/log-daily-streak', fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const last = await Activity.findOne({ user: userId, dailystreak: { $exists: true } })
                               .sort({ createdAt: -1 });
    const now = new Date();
    const eligible = !last || now - new Date(last.createdAt) >= 24 * 60 * 60 * 1000;

    if (!eligible) {
      return res.status(200).json({ message: '⏱️ Streak already logged in last 24 hours.' });
    }

    await new Activity({ dailystreak: 1, user: userId }).save();
    await notifyAndPush(userId, 'daily_streak',
      '✅ You logged a new daily streak! Keep it going 🔥', '/streaks');

    res.status(200).json({ message: '✅ New streak logged!' });
  } catch (err) {
    console.error('Log streak error:', err);
    res.status(500).json({ message: 'Failed to log streak' });
  }
});

/* ------------------------------------------------------------------
   Misc activity getters
-------------------------------------------------------------------*/
router.get('/user', fetchUser, async (req, res) => {
  try {
    const acts = await Activity.find({
      $or: [{ referral: req.user.id }, { userpost: req.user.id }, { user: req.user.id }]
    }).sort({ createdAt: -1 });

    const formatted = acts.map(a => {
      if (a.dailystreak)  return { type: 'streak',      date: a.createdAt, value: a.dailystreak };
      if (a.userpost)     return { type: 'post',        date: a.createdAt };
      if (a.referral)     return { type: 'referral',    date: a.createdAt, referral: a.referral.toString(), slabAwarded: a.slabAwarded };
      if (a.streakslab)   return { type: 'streakreward',date: a.createdAt, streakslab: a.streakslab };
      return { type: 'unknown', date: a.createdAt };
    });

    res.status(200).json({ activities: formatted });
  } catch (err) {
    console.error('[GET /api/activity/user]', err);
    res.status(500).json({ message: 'Failed to fetch user activity' });
  }
});

router.get('/community/:userId', fetchUser, async (req, res) => {
  try {
    const count = await getCommunityCount(req.params.userId);
    res.json({ communityCount: count });
  } catch (err) {
    console.error('Community count error:', err);
    res.status(500).json({ message: 'Failed to fetch community count' });
  }
});

router.get('/streak-history', fetchUser, async (req, res) => {
  try {
    const streaks = await Activity.find({
      user: req.user.id,
      dailystreak: { $exists: true }
    }).sort({ createdAt: -1 });

    const streakDates = streaks.map(s => {
      const d = new Date(s.createdAt);
      return isNaN(d.getTime()) ? null : { date: d.toISOString().split('T')[0], count: 1 };
    }).filter(Boolean);

    res.json({ streakDates });
  } catch (err) {
    console.error('Streak history error:', err);
    res.status(500).json({ message: 'Failed to fetch streak history' });
  }
});

router.get('/last-streak', fetchUser, async (req, res) => {
  try {
    const last = await Activity.findOne({
      user: req.user.id,
      dailystreak: { $exists: true }
    }).sort({ createdAt: -1 });

    if (!last) return res.json({ lastStreak: null });
    const d = new Date(last.createdAt);
    res.json({ lastStreak: isNaN(d.getTime()) ? null : d.toISOString().split('T')[0] });
  } catch (err) {
    console.error('Last streak error:', err);
    res.status(500).json({ message: 'Failed to fetch last streak' });
  }
});

module.exports = router;
