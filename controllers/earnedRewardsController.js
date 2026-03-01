// controllers/earnedRewardsController.js
'use strict';

/**
 * GET /api/auth/earned-rewards
 *
 * Single source of truth for the ObtainedRewardsModal.
 * Returns:
 *   - wallet:   live totals from User document (groceryCoupons, shares, referralToken)
 *   - redeemed: which slabs have been claimed per category
 *   - slabs:    full slab config for the user's plan (for preview in UI)
 *   - claims:   RewardClaim history enriched with resolved reward breakdowns
 *
 * Slab structures understood:
 *   POSTS    — milestones 30,70,150,300,600,1000 — each has groceryCoupons + shares
 *   STREAK   — milestones 30…360 (every 30 days) — groceryCoupons only; 0 shares/token
 *   REFERRAL — milestones 3,6,10 (grocery+shares+token) + 11–30 (referralToken only)
 */

const User        = require('../models/User');
const RewardClaim = require('../models/RewardClaim');
const { readRewards } = require('../utils/rewardManager');

/* ── Plan key resolver ──────────────────────────────────────────────────────── */
function planKeyFromUser(user) {
  if (user.subscription?.planAmount) return String(user.subscription.planAmount);
  const nameMap = { Basic: '2500', Silver: '3500', Gold: '4500' };
  return nameMap[user.subscription?.plan] || '2500';
}

/* ── Slab look-up helpers ───────────────────────────────────────────────────── */

/**
 * Streak: exact match on dailystreak number.
 * slabKey stored as "90days" → parse to 90 → find slab where dailystreak === 90
 */
function lookupStreakSlab(slabs, slabKey) {
  if (!Array.isArray(slabs) || !slabKey) return null;
  const days = Number(String(slabKey).replace('days', ''));
  if (isNaN(days)) return null;
  return slabs.find(s => s.dailystreak === days) || null;
}

/**
 * Referral: exact match on referralCount.
 * Milestone 3 → exact slab; milestone 15 → exact slab (token-only).
 * NO fuzzy fallback — every referral milestone is a distinct claimable slab.
 */
function lookupReferralSlab(slabs, milestone) {
  if (!Array.isArray(slabs) || milestone == null) return null;
  const count = Number(milestone);
  if (isNaN(count)) return null;
  return slabs.find(s => s.referralCount === count) || null;
}

/**
 * Posts: exact match on postsCount.
 * Claiming the 70-post slab always returns that slab's reward, not a cumulative one.
 */
function lookupPostSlab(slabs, milestone) {
  if (!Array.isArray(slabs) || milestone == null) return null;
  const count = Number(milestone);
  if (isNaN(count)) return null;
  return slabs.find(s => s.postsCount === count) || null;
}

/* ── Reward breakdown normaliser ────────────────────────────────────────────── */
function extractReward(slab) {
  if (!slab) return null;
  return {
    groceryCoupons: slab.groceryCoupons ?? 0,
    shares:         slab.shares         ?? 0,
    referralToken:  slab.referralToken  ?? 0,
  };
}

/* ── Controller ─────────────────────────────────────────────────────────────── */
async function getEarnedRewards(req, res) {
  try {
    const user = await User.findById(req.user.id).select(
      'subscription totalGroceryCoupons totalShares totalReferralToken ' +
      'redeemedStreakSlabs redeemedReferralSlabs redeemedPostSlabs bankDetails'
    );

    if (!user) return res.status(404).json({ message: 'User not found' });

    const planKey = planKeyFromUser(user);

    // Load slab configs — non-fatal if a file is missing
    let streakSlabs = [], referralSlabs = [], postSlabs = [];
    try { streakSlabs   = readRewards('streak',   planKey); } catch (e) { console.warn('[earnedRewards] streak slabs:', e.message); }
    try { referralSlabs = readRewards('referral', planKey); } catch (e) { console.warn('[earnedRewards] referral slabs:', e.message); }
    try { postSlabs     = readRewards('posts',    planKey); } catch (e) { console.warn('[earnedRewards] post slabs:', e.message); }

    // Fetch full RewardClaim history (most accurate record of what was awarded)
    const claims = await RewardClaim.find({ user: user._id })
      .sort({ claimedAt: -1 })
      .lean();

    // Enrich each claim with its resolved slab breakdown + display metadata
    const enrichedClaims = claims.map(claim => {
      let slab  = null;
      let title = '';
      let emoji = '🎁';
      let cardType = claim.type; // 'streak' | 'referral' | 'post'

      if (claim.type === 'streak') {
        slab  = lookupStreakSlab(streakSlabs, claim.milestone);
        const days = String(claim.milestone).replace('days', '');
        title = `Streak Reward — ${days} Days`;
        emoji = '🔥';
      } else if (claim.type === 'referral') {
        slab  = lookupReferralSlab(referralSlabs, claim.milestone);
        const isBigSlab = [3, 6, 10].includes(Number(claim.milestone));
        title = `Referral Reward — ${claim.milestone} Referral${Number(claim.milestone) !== 1 ? 's' : ''}`;
        emoji = isBigSlab ? '🤝' : '🪙';
      } else if (claim.type === 'post') {
        slab  = lookupPostSlab(postSlabs, claim.milestone);
        title = `Post Reward — ${claim.milestone} Posts`;
        emoji = '📝';
      }

      const reward = extractReward(slab);

      return {
        _id:       claim._id,
        type:      cardType,
        milestone: claim.milestone,
        claimedAt: claim.claimedAt || claim.createdAt,
        title,
        emoji,
        reward,
        // Convenience: was any real value granted?
        hasValue: reward
          ? reward.groceryCoupons > 0 || reward.shares > 0 || reward.referralToken > 0
          : false,
      };
    });

    // Wallet totals — always from User doc (canonical ledger)
    const wallet = {
      totalGroceryCoupons: user.totalGroceryCoupons ?? 0,
      totalShares:         user.totalShares         ?? 0,
      totalReferralToken:  user.totalReferralToken  ?? 0,
    };

    // Redeemed slab lists (for disabling already-claimed buttons in the UI)
    const redeemed = {
      streak:   user.redeemedStreakSlabs   ?? [],   // e.g. ['30days', '90days']
      referral: user.redeemedReferralSlabs ?? [],   // e.g. [3, 6, 10, 11]
      posts:    user.redeemedPostSlabs     ?? [],   // e.g. [30, 70]
    };

    // Slab configs (so the frontend can show reward preview per milestone)
    const slabs = {
      streak:   streakSlabs,
      referral: referralSlabs,
      posts:    postSlabs,
    };

    // Referral slab classification (big vs token-only) for UI rendering
    const referralMeta = {
      bigMilestones:   referralSlabs.filter(s => s.groceryCoupons > 0 || s.shares > 0).map(s => s.referralCount),
      tokenMilestones: referralSlabs.filter(s => s.groceryCoupons === 0 && s.shares === 0 && s.referralToken > 0).map(s => s.referralCount),
    };

    return res.status(200).json({
      planKey,
      wallet,
      redeemed,
      slabs,
      referralMeta,
      claims: enrichedClaims,
      totalClaims: enrichedClaims.length,
    });
  } catch (err) {
    console.error('[getEarnedRewards]', err);
    return res.status(500).json({ message: 'Failed to fetch earned rewards' });
  }
}

module.exports = { getEarnedRewards };