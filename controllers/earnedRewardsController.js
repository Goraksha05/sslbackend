// controllers/earnedRewardsController.js
'use strict';

/**
 * GET /api/auth/earned-rewards  (also mounted at GET /api/rewards/earned-rewards)
 *
 * Single source of truth for the ObtainedRewardsModal.
 * Returns:
 *   - wallet:        live totals from User document
 *   - redeemed:      which slabs have been claimed per category
 *   - slabs:         full slab config for the user's plan (for preview in UI)
 *   - claims:        RewardClaim history enriched with resolved reward breakdowns
 *   - eligibility:   gate status so the frontend can render contextual CTAs
 *                    without a separate /reward-eligibility request
 *
 * ELIGIBILITY ENFORCEMENT (read-side):
 *   This endpoint does NOT block on ineligibility — it always returns wallet +
 *   slab data so the UI can show "what you'll earn" even before the user is
 *   eligible. The `eligibility` block in the response tells the frontend
 *   whether claim buttons should be active or show a gate.
 *
 *   The WRITE-side (claim endpoints in activity.js) is where hard blocking
 *   happens via the requireRewardEligibility middleware.
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

/* ── Subscription active check ──────────────────────────────────────────────── */
function isSubscriptionActive(sub) {
  if (!sub?.active) return false;
  if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) return false;
  return true;
}

/* ── Slab look-up helpers ───────────────────────────────────────────────────── */

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

/* ── Reward breakdown normaliser ────────────────────────────────────────────── */
function extractReward(slab) {
  if (!slab) return null;
  return {
    groceryCoupons: slab.groceryCoupons ?? 0,
    shares:         slab.shares ?? 0,
    referralToken:  slab.referralToken ?? 0,
  };
}

/* ── Build eligibility block ─────────────────────────────────────────────────── */
function buildEligibilityBlock(user) {
  const kycStatus  = user.kyc?.status ?? 'not_started';
  const kycPassed  = kycStatus === 'verified';
  const subActive  = !!user.subscription?.active;
  const subExpired = subActive && user.subscription?.expiresAt
    && new Date(user.subscription.expiresAt) < new Date();
  const subPassed  = subActive && !subExpired;
  const frozen     = !!user.trustFlags?.rewardsFrozen;

  let blockerCode = null;
  if (frozen)                       blockerCode = 'REWARDS_FROZEN';
  else if (!kycPassed && !subPassed) blockerCode = 'KYC_AND_SUBSCRIPTION';
  else if (!kycPassed)              blockerCode = 'KYC_NOT_VERIFIED';
  else if (!subPassed)              blockerCode = 'SUBSCRIPTION_REQUIRED';

  return {
    eligible:      !frozen && kycPassed && subPassed,
    rewardsFrozen: frozen,
    blockerCode,
    gates: {
      kyc: {
        passed:     kycPassed,
        status:     kycStatus,
        verifiedAt: user.kyc?.verifiedAt ?? null,
      },
      subscription: {
        passed:    subPassed,
        active:    subActive,
        expired:   subExpired,
        plan:      user.subscription?.plan ?? null,
        expiresAt: user.subscription?.expiresAt ?? null,
      },
    },
  };
}

/* ── Controller ─────────────────────────────────────────────────────────────── */
async function getEarnedRewards(req, res) {
  try {
    const user = await User.findById(req.user.id).select(
      'subscription totalGroceryCoupons totalShares totalReferralToken ' +
      'redeemedStreakSlabs redeemedReferralSlabs redeemedPostSlabs bankDetails ' +
      'kyc.status kyc.verifiedAt trustFlags'
    );

    if (!user) return res.status(404).json({ message: 'User not found' });

    const planKey = planKeyFromUser(user);

    // Load slab configs — non-fatal if a file is missing
    let streakSlabs = [], referralSlabs = [], postSlabs = [];
    try { streakSlabs   = readRewards('streak',   planKey); } catch (e) { console.warn('[earnedRewards] streak slabs:', e.message); }
    try { referralSlabs = readRewards('referral',  planKey); } catch (e) { console.warn('[earnedRewards] referral slabs:', e.message); }
    try { postSlabs     = readRewards('posts',     planKey); } catch (e) { console.warn('[earnedRewards] post slabs:', e.message); }

    // ── Eligibility block (included in response for UI gate rendering) ──────
    const eligibility = buildEligibilityBlock(user);

    // ── Fraud / risk guard: return early ONLY for frozen rewards ────────────
    // We still return eligibility + slab previews so the UI can explain why.
    if (user.trustFlags?.rewardsFrozen) {
      return res.status(403).json({
        message: 'Your reward payouts are temporarily suspended pending verification.',
        code:    'REWARDS_FROZEN',
        eligibility,
        kycRequired: user.trustFlags?.kycRequired || false,
      });
    }

    // Fetch full RewardClaim history
    const claims = await RewardClaim.find({ user: user._id })
      .sort({ claimedAt: -1 })
      .lean();

    // Enrich each claim with its resolved slab breakdown + display metadata
    const enrichedClaims = claims.map(claim => {
      let slab  = null;
      let title = '';
      let emoji = '🎁';
      const cardType = claim.type;

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
        hasValue: reward
          ? reward.groceryCoupons > 0 || reward.shares > 0 || reward.referralToken > 0
          : false,
      };
    });

    // Wallet totals — always from User doc (canonical ledger)
    const wallet = {
      totalGroceryCoupons: user.totalGroceryCoupons ?? 0,
      totalShares:         user.totalShares ?? 0,
      totalReferralToken:  user.totalReferralToken ?? 0,
    };

    // Redeemed slab lists (for disabling already-claimed buttons in the UI)
    const redeemed = {
      streak:   user.redeemedStreakSlabs   ?? [],
      referral: user.redeemedReferralSlabs ?? [],
      posts:    user.redeemedPostSlabs     ?? [],
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
      claims:      enrichedClaims,
      totalClaims: enrichedClaims.length,
      // ── NEW: eligibility block so the frontend never needs a separate call ─
      eligibility,
    });
  } catch (err) {
    console.error('[getEarnedRewards]', err);
    return res.status(500).json({ message: 'Failed to fetch earned rewards' });
  }
}

module.exports = { getEarnedRewards };