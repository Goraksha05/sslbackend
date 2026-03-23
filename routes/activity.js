// routes/activity.js
'use strict';

const express  = require('express');
const router   = express.Router();

const Activity    = require('../models/Activity');
const User        = require('../models/User');
const PostsSchema = require('../models/Posts');
const RewardClaim = require('../models/RewardClaim');
const Notification = require('../models/Notification');
const fetchUser   = require('../middleware/fetchuser');

// ── NEW: Reward eligibility gate (KYC + subscription) ─────────────────────────
const requireRewardEligibility = require('../middleware/requireRewardEligibility');

const { calculateReferralReward } = require('../utils/tierCalculation/calculateReferralReward');
const { calculatePostsReward }    = require('../utils/tierCalculation/calculatePostsReward');
const { calculateStreakReward }   = require('../utils/tierCalculation/calculateStreakReward');

const { getIO }         = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser         = require('../utils/notifyUser');
const { getCommunityCount } = require('../utils/communityUtils');

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function planKeyFromUser(user) {
  if (user.subscription?.planAmount) return String(user.subscription.planAmount);
  const nameMap = { Basic: '2500', Silver: '3500', Gold: '4500' };
  return nameMap[user.subscription?.plan] || '2500';
}

function mergeBankDetails(user, bankDetails) {
  if (!bankDetails) return;
  user.bankDetails = {
    accountNumber: bankDetails.accountNumber ?? user.bankDetails?.accountNumber,
    ifscCode:      bankDetails.ifscCode      ?? user.bankDetails?.ifscCode,
    panNumber:     bankDetails.panNumber     ?? user.bankDetails?.panNumber,
  };
}

async function notifyAndPush(userId, type, message, url) {
  try {
    await Notification.create({ user: userId, sender: userId, type, message, url });
    await notifyUser(userId, message, type);
    sendPushToUser(userId, { title: message.split('!')[0], message, url });
    getIO().to(userId.toString()).emit('notification', { type, from: userId, message });
  } catch (err) {
    console.error('[notifyAndPush] non-fatal error:', err.message);
  }
}

/* ── Referral Reward ─────────────────────────────────────────────────────────── */
// requireRewardEligibility enforces KYC verified + active subscription BEFORE
// any business logic runs. The individual subscription checks below are kept as
// a secondary safety net but the gate middleware is the primary enforcement.
router.post('/referral', fetchUser, requireRewardEligibility, async (req, res) => {
  try {
    const { referralCount, bankDetails } = req.body;
    const count = Number(referralCount);

    if (!count || isNaN(count) || count <= 0) {
      return res.status(400).json({ message: 'Invalid referral count provided.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // Secondary subscription guard (belt-and-suspenders — gate middleware is primary)
    if (!user.subscription?.active) {
      return res.status(403).json({
        message: 'Active subscription required to claim rewards.',
        code: 'SUBSCRIPTION_REQUIRED',
      });
    }

    // Secondary KYC guard
    if (user.kyc?.status !== 'verified') {
      return res.status(403).json({
        message: 'KYC verification required to claim rewards.',
        code: 'KYC_NOT_VERIFIED',
      });
    }

    const activeReferrals = await User.countDocuments({
      referral: user._id,
      'subscription.active': true,
    });

    if (activeReferrals < count) {
      return res.status(400).json({
        message: `You need ${count} active referrals to claim this reward. You currently have ${activeReferrals}.`,
      });
    }

    if (user.redeemedReferralSlabs?.includes(count)) {
      return res.status(409).json({ message: 'You have already claimed this referral milestone.' });
    }

    const plan   = planKeyFromUser(user);
    const reward = calculateReferralReward(count, plan);

    if (!reward) {
      return res.status(404).json({ message: `No reward configuration found for ${count} referrals on your plan.` });
    }

    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = reward;

    await Promise.all([
      new Activity({
        user:        user._id,
        referral:    user._id,
        type:        'referral_reward',
        slabAwarded: count,
      }).save(),
      RewardClaim.create({ user: user._id, type: 'referral', milestone: String(count) }),
    ]);

    user.redeemedReferralSlabs.push(count);
    user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + groceryCoupons;
    user.totalShares         = (user.totalShares         || 0) + shares;
    user.totalReferralToken  = (user.totalReferralToken  || 0) + referralToken;
    mergeBankDetails(user, bankDetails);
    await user.save();

    notifyAndPush(
      user._id,
      'referral_reward',
      `🎉 You claimed a referral reward for ${count} referrals!`,
      '/rewards/referral',
    );

    return res.status(200).json({
      message: `Referral reward for ${count} referrals claimed!`,
      reward: { groceryCoupons, shares, referralToken },
      wallet: {
        totalGroceryCoupons: user.totalGroceryCoupons,
        totalShares:         user.totalShares,
        totalReferralToken:  user.totalReferralToken,
        redeemedReferralSlabs: user.redeemedReferralSlabs,
      },
    });
  } catch (err) {
    console.error('[POST /referral]', err);
    return res.status(500).json({ message: 'Server error during referral reward claim.' });
  }
});

/* ── Invited List ────────────────────────────────────────────────────────────── */
router.get('/invited/:referralId', fetchUser, async (req, res) => {
  try {
    const inviter = await User.findOne({ referralId: req.params.referralId }).lean();
    if (!inviter) return res.status(404).json([]);

    const invited = await User.find({ referral: inviter._id })
      .select('name email subscription.active')
      .lean();

    return res.json(invited);
  } catch (err) {
    console.error('[GET /invited]', err);
    return res.status(500).json([]);
  }
});

/* ── Post Reward ─────────────────────────────────────────────────────────────── */
router.post('/post-reward', fetchUser, requireRewardEligibility, async (req, res) => {
  try {
    const { postreward, bankDetails } = req.body;
    const milestone = Number(postreward);

    if (!milestone || isNaN(milestone) || milestone <= 0) {
      return res.status(400).json({ message: 'Invalid post milestone provided.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!user.subscription?.active) {
      return res.status(403).json({
        message: 'Active subscription required to claim rewards.',
        code: 'SUBSCRIPTION_REQUIRED',
      });
    }

    if (user.kyc?.status !== 'verified') {
      return res.status(403).json({
        message: 'KYC verification required to claim rewards.',
        code: 'KYC_NOT_VERIFIED',
      });
    }

    const postCount = await PostsSchema.countDocuments({
      user_id: user._id,
      'moderation.status': { $ne: 'rejected' },
    });

    if (postCount < milestone) {
      return res.status(400).json({
        message: `You need ${milestone} posts to claim this reward. You currently have ${postCount}.`,
      });
    }

    if (user.redeemedPostSlabs?.includes(milestone)) {
      return res.status(409).json({ message: 'You have already claimed this post milestone.' });
    }

    const plan   = planKeyFromUser(user);
    const reward = calculatePostsReward(milestone, plan);

    if (!reward) {
      return res.status(404).json({ message: `No reward configuration found for ${milestone} posts on your plan.` });
    }

    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = reward;

    await Promise.all([
      new Activity({
        user:        user._id,
        userpost:    user._id,
        slabAwarded: milestone,
      }).save(),
      RewardClaim.create({ user: user._id, type: 'post', milestone: String(milestone) }),
    ]);

    user.redeemedPostSlabs.push(milestone);
    user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + groceryCoupons;
    user.totalShares         = (user.totalShares         || 0) + shares;
    user.totalReferralToken  = (user.totalReferralToken  || 0) + referralToken;
    mergeBankDetails(user, bankDetails);
    await user.save();

    notifyAndPush(
      user._id,
      'post_reward',
      `🚀 You claimed a post reward for ${milestone} posts!`,
      '/rewards/posts',
    );

    return res.status(200).json({
      message: `Post reward for ${milestone} posts claimed!`,
      reward: { groceryCoupons, shares, referralToken },
      wallet: {
        totalGroceryCoupons: user.totalGroceryCoupons,
        totalShares:         user.totalShares,
        totalReferralToken:  user.totalReferralToken,
        redeemedPostSlabs:   user.redeemedPostSlabs,
      },
    });
  } catch (err) {
    console.error('[POST /post-reward]', err);
    return res.status(500).json({ message: 'Server error during post reward claim.' });
  }
});

/* ── Streak Reward ───────────────────────────────────────────────────────────── */
router.post('/streak-reward', fetchUser, requireRewardEligibility, async (req, res) => {
  try {
    const { streakslab, bankDetails } = req.body;

    const daysRequired = Number(
      typeof streakslab === 'string' ? streakslab.replace('days', '') : streakslab
    );

    if (!daysRequired || isNaN(daysRequired) || daysRequired <= 0) {
      return res.status(400).json({ message: 'Invalid streak milestone.' });
    }

    const slabKey = `${daysRequired}days`;

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!user.subscription?.active) {
      return res.status(403).json({
        message: 'Active subscription required to claim rewards.',
        code: 'SUBSCRIPTION_REQUIRED',
      });
    }

    if (user.kyc?.status !== 'verified') {
      return res.status(403).json({
        message: 'KYC verification required to claim rewards.',
        code: 'KYC_NOT_VERIFIED',
      });
    }

    const streakDocs = await Activity.find({
      user:        user._id,
      dailystreak: { $exists: true, $ne: null },
    }).select('createdAt').lean();

    const uniqueDays = new Set(
      streakDocs.map(d => new Date(d.createdAt).toISOString().split('T')[0])
    );
    const streakCount = uniqueDays.size;

    if (streakCount < daysRequired) {
      return res.status(400).json({
        message: `You need ${daysRequired} streak days to claim this reward. You currently have ${streakCount}.`,
      });
    }

    if (!Array.isArray(user.redeemedStreakSlabs)) user.redeemedStreakSlabs = [];

    if (user.redeemedStreakSlabs.includes(slabKey)) {
      return res.status(409).json({ message: 'You have already claimed this streak milestone.' });
    }

    const plan   = planKeyFromUser(user);
    const reward = calculateStreakReward(daysRequired, plan);

    if (!reward) {
      return res.status(404).json({ message: `No reward configuration found for ${daysRequired} days on your plan.` });
    }

    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = reward;

    await Promise.all([
      new Activity({ user: user._id, streakslab: slabKey }).save(),
      RewardClaim.create({ user: user._id, type: 'streak', milestone: slabKey }),
    ]);

    user.redeemedStreakSlabs.push(slabKey);
    user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + groceryCoupons;
    user.totalShares         = (user.totalShares         || 0) + shares;
    user.totalReferralToken  = (user.totalReferralToken  || 0) + referralToken;
    mergeBankDetails(user, bankDetails);
    await user.save();

    notifyAndPush(
      user._id,
      'streak_reward',
      `🔥 You claimed a streak reward for ${daysRequired} days!`,
      '/rewards/streaks',
    );

    return res.status(200).json({
      message: `Streak reward for ${daysRequired} days claimed!`,
      reward: { groceryCoupons, shares, referralToken },
      wallet: {
        totalGroceryCoupons:  user.totalGroceryCoupons,
        totalShares:          user.totalShares,
        totalReferralToken:   user.totalReferralToken,
        redeemedStreakSlabs:  user.redeemedStreakSlabs,
      },
    });
  } catch (err) {
    console.error('[POST /streak-reward]', err);
    return res.status(500).json({ message: err.message || 'Server error during streak reward claim.' });
  }
});

/* ── Daily Streak Logging ────────────────────────────────────────────────────── */
// No eligibility gate here — logging a streak is always allowed (it is not a reward claim)
router.post('/log-daily-streak', fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const alreadyToday = await Activity.findOne({
      user:        userId,
      dailystreak: { $exists: true },
      createdAt:   { $gte: today },
    });

    if (alreadyToday) {
      return res.status(200).json({ message: '⏱️ Streak already logged today. Come back tomorrow!' });
    }

    await new Activity({ dailystreak: 1, user: userId }).save();

    notifyAndPush(userId, 'daily_streak', '✅ Daily streak logged! Keep it going 🔥', '/streaks');

    return res.status(200).json({ message: '✅ New daily streak logged!' });
  } catch (err) {
    console.error('[POST /log-daily-streak]', err);
    return res.status(500).json({ message: 'Failed to log streak.' });
  }
});

/* ── Activity History ────────────────────────────────────────────────────────── */
router.get('/user', fetchUser, async (req, res) => {
  try {
    const acts = await Activity.find({
      $or: [
        { referral: req.user.id },
        { userpost: req.user.id },
        { user:     req.user.id },
      ],
    }).sort({ createdAt: -1 }).lean();

    const formatted = acts.map(a => {
      if (a.streakslab)              return { type: 'streakreward',   date: a.createdAt, streakslab: a.streakslab };
      if (a.dailystreak != null)     return { type: 'streak',         date: a.createdAt, value: a.dailystreak };
      if (a.referral && a.slabAwarded != null)
                                     return { type: 'referral_reward',date: a.createdAt, slabAwarded: a.slabAwarded };
      if (a.referral)                return { type: 'referral',       date: a.createdAt };
      if (a.userpost && a.slabAwarded != null)
                                     return { type: 'post',           date: a.createdAt, slabAwarded: a.slabAwarded };
      if (a.userpost)                return { type: 'post',           date: a.createdAt };
      return { type: 'unknown', date: a.createdAt };
    });

    return res.status(200).json({ activities: formatted });
  } catch (err) {
    console.error('[GET /activity/user]', err);
    return res.status(500).json({ message: 'Failed to fetch user activity.' });
  }
});

/* ── Community Count ─────────────────────────────────────────────────────────── */
router.get('/community/:userId', fetchUser, async (req, res) => {
  try {
    const count = await getCommunityCount(req.params.userId);
    return res.json({ communityCount: count });
  } catch (err) {
    console.error('[GET /community]', err);
    return res.status(500).json({ message: 'Failed to fetch community count.' });
  }
});

/* ── Streak History (heatmap) ────────────────────────────────────────────────── */
router.get('/streak-history', fetchUser, async (req, res) => {
  try {
    const streaks = await Activity.find({
      user:        req.user.id,
      dailystreak: { $exists: true },
    }).sort({ createdAt: -1 }).lean();

    const dateMap = new Map();
    for (const s of streaks) {
      const d = new Date(s.createdAt);
      if (isNaN(d.getTime())) continue;
      const key = d.toISOString().split('T')[0];
      dateMap.set(key, (dateMap.get(key) || 0) + 1);
    }

    const streakDates = Array.from(dateMap.entries()).map(([date, count]) => ({ date, count }));

    return res.json({ streakDates, totalUniqueDays: dateMap.size });
  } catch (err) {
    console.error('[GET /streak-history]', err);
    return res.status(500).json({ message: 'Failed to fetch streak history.' });
  }
});

/* ── Last Streak ─────────────────────────────────────────────────────────────── */
router.get('/last-streak', fetchUser, async (req, res) => {
  try {
    const last = await Activity.findOne({
      user:        req.user.id,
      dailystreak: { $exists: true },
    }).sort({ createdAt: -1 }).lean();

    if (!last) return res.json({ lastStreak: null });

    const d = new Date(last.createdAt);
    return res.json({
      lastStreak: isNaN(d.getTime()) ? null : d.toISOString().split('T')[0],
    });
  } catch (err) {
    console.error('[GET /last-streak]', err);
    return res.status(500).json({ message: 'Failed to fetch last streak.' });
  }
});

/* ── Eligibility Check Endpoint ──────────────────────────────────────────────── */
// Lightweight endpoint for the frontend to check reward eligibility without
// hitting a claim endpoint. Returns structured gate info.
router.get('/reward-eligibility', fetchUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('kyc subscription trustFlags')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    const kycStatus   = user.kyc?.status ?? 'not_started';
    const kycPassed   = kycStatus === 'verified';
    const subActive   = !!user.subscription?.active;
    const subExpired  = subActive && user.subscription?.expiresAt
      && new Date(user.subscription.expiresAt) < new Date();
    const subPassed   = subActive && !subExpired;
    const rewardsFrozen = !!user.trustFlags?.rewardsFrozen;

    return res.json({
      eligible: kycPassed && subPassed && !rewardsFrozen,
      rewardsFrozen,
      gates: {
        kyc: {
          passed:       kycPassed,
          status:       kycStatus,
          verifiedAt:   user.kyc?.verifiedAt ?? null,
        },
        subscription: {
          passed:    subPassed,
          active:    subActive,
          expired:   subExpired,
          plan:      user.subscription?.plan ?? null,
          expiresAt: user.subscription?.expiresAt ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[GET /reward-eligibility]', err);
    return res.status(500).json({ message: 'Failed to check eligibility.' });
  }
});

module.exports = router;