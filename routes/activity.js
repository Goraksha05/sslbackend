/**
 * routes/activity.js  (Refactored)
 *
 * All claim business logic now lives in RewardEngine.js.
 * This file is reduced to:
 *   - Input parsing & validation
 *   - Calling the engine
 *   - Mapping RewardEngineError → HTTP status
 *   - Firing notifications (fire-and-forget)
 *
 * No business rules live here — just HTTP transport.
 */

'use strict';

const express  = require('express');
const router   = express.Router();

const Activity    = require('../models/Activity');
const User        = require('../models/User');
const Notification = require('../models/Notification');
const fetchUser   = require('../middleware/fetchuser');
const requireRewardEligibility = require('../middleware/requireRewardEligibility');
const { handler } = require('../routes/redeemGrocery');
const engine = require('../services/RewardEngine');
const { RewardEngineError } = engine;
const { getIO }         = require('../sockets/socketManager');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser         = require('../utils/notifyUser');
const { getCommunityCount } = require('../utils/communityUtils');

// ── Error → HTTP mapping ──────────────────────────────────────────────────────

const CODE_TO_STATUS = {
  USER_NOT_FOUND:       404,
  KYC_NOT_VERIFIED:     403,
  SUBSCRIPTION_REQUIRED:403,
  REWARDS_FROZEN:       403,
  ALREADY_CLAIMED:      409,
  SLAB_NOT_FOUND:       404,
  MILESTONE_NOT_REACHED:400,
  INVALID_TYPE:         400,
};

function handleEngineError(err, res) {
  if (err instanceof RewardEngineError) {
    return res.status(CODE_TO_STATUS[err.code] || err.status || 400).json({
      message: err.message,
      code:    err.code,
    });
  }
  console.error('[activity route] Unexpected error:', err);
  return res.status(500).json({ message: 'Server error during reward claim.' });
}

// ── Notification helper (fire-and-forget) ─────────────────────────────────────

function notifyAndPush(userId, type, message, url) {
  Promise.allSettled([
    Notification.create({ user: userId, sender: userId, type, message, url }),
    notifyUser(userId, message, type),
    sendPushToUser(userId, { title: message.split('!')[0], message, url }),
  ]).catch(() => {});
  try {
    getIO().to(userId.toString()).emit('notification', { type, from: userId, message });
  } catch (_) {}
}

// ═════════════════════════════════════════════════════════════════════════════
// REFERRAL REWARD
// ═════════════════════════════════════════════════════════════════════════════

router.post('/referral', fetchUser, requireRewardEligibility, async (req, res) => {
  const { referralCount, bankDetails } = req.body;
  const count = Number(referralCount);

  if (!Number.isInteger(count) || count <= 0) {
    return res.status(400).json({ message: 'Invalid referralCount.' });
  }

  try {
    const result = await engine.claimReferralReward(req.user.id, count, bankDetails);

    notifyAndPush(
      req.user.id,
      'referral_reward',
      `🎉 You claimed a referral reward for ${count} referrals!`,
      '/rewards/referral'
    );

    return res.status(200).json({
      message: `Referral reward for ${count} referrals claimed!`,
      planKey: result.planKey,
      reward:  result.reward,
      wallet:  result.wallet,
    });
  } catch (err) {
    return handleEngineError(err, res);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST REWARD
// ═════════════════════════════════════════════════════════════════════════════

router.post('/post-reward', fetchUser, requireRewardEligibility, async (req, res) => {
  const { postreward, bankDetails } = req.body;
  const milestone = Number(postreward);

  if (!Number.isInteger(milestone) || milestone <= 0) {
    return res.status(400).json({ message: 'Invalid post milestone.' });
  }

  try {
    const result = await engine.claimPostReward(req.user.id, milestone, bankDetails);

    notifyAndPush(
      req.user.id,
      'post_reward',
      `🚀 You claimed a post reward for ${milestone} posts!`,
      '/rewards/posts'
    );

    return res.status(200).json({
      message: `Post reward for ${milestone} posts claimed!`,
      planKey: result.planKey,
      reward:  result.reward,
      wallet:  result.wallet,
    });
  } catch (err) {
    return handleEngineError(err, res);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STREAK REWARD
// ═════════════════════════════════════════════════════════════════════════════

router.post('/streak-reward', fetchUser, requireRewardEligibility, async (req, res) => {
  const { streakslab, bankDetails } = req.body;
  const daysRequired = Number(
    typeof streakslab === 'string' ? streakslab.replace('days', '') : streakslab
  );

  if (!Number.isInteger(daysRequired) || daysRequired <= 0) {
    return res.status(400).json({ message: 'Invalid streak milestone.' });
  }

  try {
    const result = await engine.claimStreakReward(req.user.id, daysRequired, bankDetails);

    notifyAndPush(
      req.user.id,
      'streak_reward',
      `🔥 You claimed a streak reward for ${daysRequired} days!`,
      '/rewards/streaks'
    );

    return res.status(200).json({
      message: `Streak reward for ${daysRequired} days claimed!`,
      planKey: result.planKey,
      reward:  result.reward,
      wallet:  result.wallet,
    });
  } catch (err) {
    return handleEngineError(err, res);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INVITED LIST
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// DAILY STREAK LOGGING
// ═════════════════════════════════════════════════════════════════════════════

router.post('/log-daily-streak', fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const today  = new Date();
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

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITY HISTORY
// ═════════════════════════════════════════════════════════════════════════════

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
      if (a.streakslab)                        return { type: 'streakreward',   date: a.createdAt, streakslab: a.streakslab };
      if (a.dailystreak != null)               return { type: 'streak',         date: a.createdAt, value: a.dailystreak };
      if (a.referral && a.slabAwarded != null) return { type: 'referral_reward',date: a.createdAt, slabAwarded: a.slabAwarded };
      if (a.referral)                          return { type: 'referral',       date: a.createdAt };
      if (a.userpost && a.slabAwarded != null) return { type: 'post',           date: a.createdAt, slabAwarded: a.slabAwarded };
      if (a.userpost)                          return { type: 'post',           date: a.createdAt };
      return { type: 'unknown', date: a.createdAt };
    });

    return res.status(200).json({ activities: formatted });
  } catch (err) {
    console.error('[GET /activity/user]', err);
    return res.status(500).json({ message: 'Failed to fetch user activity.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// COMMUNITY COUNT
// ═════════════════════════════════════════════════════════════════════════════

router.get('/community/:userId', fetchUser, async (req, res) => {
  try {
    const count = await getCommunityCount(req.params.userId);
    return res.json({ communityCount: count });
  } catch (err) {
    console.error('[GET /community]', err);
    return res.status(500).json({ message: 'Failed to fetch community count.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STREAK HISTORY (heatmap)
// ═════════════════════════════════════════════════════════════════════════════

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

    return res.json({
      streakDates:    Array.from(dateMap.entries()).map(([date, count]) => ({ date, count })),
      totalUniqueDays: dateMap.size,
    });
  } catch (err) {
    console.error('[GET /streak-history]', err);
    return res.status(500).json({ message: 'Failed to fetch streak history.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LAST STREAK
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// ELIGIBILITY CHECK (lightweight read-only)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/reward-eligibility', fetchUser, async (req, res) => {
  try {
    const result = await engine.getEligibility(req.user.id);
    return res.json(result);
  } catch (err) {
    return handleEngineError(err, res);
  }
});

//==============================================================================
//  ------------------ GET /api/activity/dashboard ----─────────────────────────
//==============================================================================
router.get('/dashboard', fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
 
    // Run all three DB queries in parallel — no sequential waterfall.
    const [streakDocs, referredUsers] = await Promise.all([
      // 1. All streak activity entries for this user
      Activity.find(
        { user: userId, dailystreak: { $exists: true, $ne: null } },
        'createdAt'
      ).lean(),
 
      // 2. All users referred by this user
      User.find({ referral: userId })
        .select('name email username subscription.active subscription.plan')
        .lean(),
    ]);
 
    // ── Streak: count unique IST calendar days ─────────────────────────────
    // We reduce to a Map<dateString, count> so duplicate log entries on the
    // same day are collapsed into a single date (IST-aware).
    const dateMap = new Map();
    for (const doc of streakDocs) {
      const d = new Date(doc.createdAt);
      if (isNaN(d.getTime())) continue;
 
      // Convert to IST (UTC+5:30) date string using Intl — no manual offset.
      const key = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d);
 
      dateMap.set(key, (dateMap.get(key) ?? 0) + 1);
    }
 
    const streakDates = Array.from(dateMap.entries()).map(([date, count]) => ({
      date,
      count,
    }));
    const streakCount = dateMap.size; // unique days
 
    // ── Referrals ──────────────────────────────────────────────────────────
    const referralCount       = referredUsers.length;
    const activeReferralCount = referredUsers.filter(
      (u) => u.subscription?.active
    ).length;
 
    return res.json({
      streakCount,
      streakDates,
      referralCount,
      activeReferralCount,
      referredUsers,
    });
  } catch (err) {
    console.error('[GET /activity/dashboard]', err);
    return res.status(500).json({ message: 'Failed to load dashboard data.' });
  }
});


module.exports = router;