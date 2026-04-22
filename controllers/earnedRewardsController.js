/**
 * controllers/earnedRewardsController.js  (Refactored)
 *
 * Changes from original:
 *   - planKeyFromUser() replaced by getUserPlan() from the canonical util
 *   - eligibility block now uses engine.getEligibility() — no duplicated logic
 *   - Slab look-ups now use the same finder functions as the engine
 *   - Added planKey to the response so the frontend knows which tier is active
 */

'use strict';

const User        = require('../models/User');
const RewardClaim = require('../models/RewardClaim');
const { readRewards }   = require('../utils/rewardManager');
const { getUserPlan }   = require('../utils/getPlanKey');
const { getEligibility } = require('../services/RewardEngine');

// ── Slab look-up helpers (mirrors RewardEngine._internals) ────────────────────

function lookupStreakSlab(slabs, slabKey) {
  if (!Array.isArray(slabs) || !slabKey) return null;
  const days = Number(String(slabKey).replace('days', ''));
  if (isNaN(days)) return null;
  return slabs.find(s => s.dailystreak === days) || null;
}

function lookupReferralSlab(slabs, milestone) {
  if (!Array.isArray(slabs) || milestone == null) return null;
  const count = Number(milestone);
  if (isNaN(count)) return null;
  return slabs.find(s => s.referralCount === count) || null;
}

function lookupPostSlab(slabs, milestone) {
  if (!Array.isArray(slabs) || milestone == null) return null;
  const count = Number(milestone);
  if (isNaN(count)) return null;
  return slabs.find(s => s.postsCount === count) || null;
}

function extractReward(slab) {
  if (!slab) return null;
  return {
    groceryCoupons: slab.groceryCoupons ?? 0,
    shares:         slab.shares ?? 0,
    referralToken:  slab.referralToken ?? 0,
  };
}

// ── Controller ────────────────────────────────────────────────────────────────

async function getEarnedRewards(req, res) {
  try {
    const user = await User.findById(req.user.id).select(
      'subscription totalGroceryCoupons totalRedeemedGrocery totalShares totalReferralToken ' +
      'redeemedStreakSlabs redeemedReferralSlabs redeemedPostSlabs bankDetails ' +
      'kyc.status kyc.verifiedAt trustFlags'
    );

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Frozen rewards — return early with eligibility block
    if (user.trustFlags?.rewardsFrozen) {
      const eligibility = await getEligibility(user._id);
      return res.status(403).json({
        message:     'Your reward payouts are temporarily suspended pending verification.',
        code:        'REWARDS_FROZEN',
        eligibility,
        kycRequired: user.trustFlags?.kycRequired || false,
      });
    }

    // Use canonical plan resolver
    const planKey = getUserPlan(user);

    // Load slab configs — non-fatal if a file is missing
    let streakSlabs = [], referralSlabs = [], postSlabs = [];
    try { streakSlabs   = readRewards('streak',   planKey); } catch (e) { console.warn('[earnedRewards] streak slabs:', e.message); }
    try { referralSlabs = readRewards('referral',  planKey); } catch (e) { console.warn('[earnedRewards] referral slabs:', e.message); }
    try { postSlabs     = readRewards('posts',     planKey); } catch (e) { console.warn('[earnedRewards] post slabs:', e.message); }

    // Eligibility block (non-blocking — always return slabs for preview)
    const eligibility = await getEligibility(user._id);

    // Fetch claim history
    const claims = await RewardClaim.find({ user: user._id })
      .sort({ claimedAt: -1 })
      .lean();

    // Enrich each claim
    const enrichedClaims = claims.map(claim => {
      let slab  = null;
      let title = '';
      let emoji = '🎁';

      if (claim.type === 'streak') {
        slab  = lookupStreakSlab(streakSlabs, claim.milestone);
        const days = String(claim.milestone).replace('days', '');
        title = `Streak Reward — ${days} Days`;
        emoji = '🔥';
      } else if (claim.type === 'referral') {
        slab  = lookupReferralSlab(referralSlabs, claim.milestone);
        title = `Referral Reward — ${claim.milestone} Referral${Number(claim.milestone) !== 1 ? 's' : ''}`;
        emoji = [3, 6, 10].includes(Number(claim.milestone)) ? '🤝' : '🪙';
      } else if (claim.type === 'post') {
        slab  = lookupPostSlab(postSlabs, claim.milestone);
        title = `Post Reward — ${claim.milestone} Posts`;
        emoji = '📝';
      }

      const reward = extractReward(slab);

      return {
        _id:       claim._id,
        type:      claim.type,
        milestone: claim.milestone,
        claimedAt: claim.claimedAt || claim.createdAt,
        title,
        emoji,
        reward,
        hasValue: reward
          ? reward.groceryCoupons > 0 || reward.shares > 0 || reward.referralToken > 0
          : false,
      };
    });

    const totalEarned   = user.totalGroceryCoupons  ?? 0;
    const totalRedeemed = user.totalRedeemedGrocery  ?? 0;

    const wallet = {
      // Legacy field kept for backward compatibility — contains AVAILABLE balance
      totalGroceryCoupons:  totalEarned - totalRedeemed,   // ← COMPUTED, not raw field
      // New explicit fields for any consumer that wants the full ledger picture
      totalEarned,
      totalRedeemed,
      availableBalance:     totalEarned - totalRedeemed,
      // Non-cash assets unchanged
      totalShares:          user.totalShares ?? 0,
      totalReferralToken:   user.totalReferralToken ?? 0,
    };

    const redeemed = {
      streak:   user.redeemedStreakSlabs   ?? [],
      referral: user.redeemedReferralSlabs ?? [],
      posts:    user.redeemedPostSlabs     ?? [],
    };

    const slabs = { streak: streakSlabs, referral: referralSlabs, posts: postSlabs };

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
      claims:      enrichedClaims,
      totalClaims: enrichedClaims.length,
      eligibility,
    });
  } catch (err) {
    console.error('[getEarnedRewards]', err);
    return res.status(500).json({ message: 'Failed to fetch earned rewards' });
  }
}

module.exports = { getEarnedRewards };