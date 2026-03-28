/**
 * services/RewardEngine.js
 *
 * Central Reward Engine — single source of truth for all reward processing.
 *
 * Responsibilities:
 *   1. Resolve the user's canonical plan key (2500 | 3500 | 4500)
 *   2. Look up the correct slab from JSON reward files
 *   3. Validate milestone eligibility (count check, duplicate check)
 *   4. Apply reward atomically via a MongoDB session/transaction
 *   5. Write RewardClaim + Activity records in the same transaction
 *   6. Return a structured result the route handler can respond with
 *
 * Usage (from any route):
 *   const engine = require('../services/RewardEngine');
 *   const result = await engine.claimReferralReward(userId, count, bankDetails, session?);
 *
 * All public methods throw RewardEngineError on failure.
 * Routes catch RewardEngineError and map it to the correct HTTP status.
 */

'use strict';

const mongoose = require('mongoose');

const User        = require('../models/User');
const Activity    = require('../models/Activity');
const RewardClaim = require('../models/RewardClaim');

const { readRewards }    = require('../utils/rewardManager');
const { getUserPlan }    = require('../utils/getPlanKey');

// ─── Custom error ─────────────────────────────────────────────────────────────

class RewardEngineError extends Error {
  /**
   * @param {string} message  Human-readable message
   * @param {string} code     Machine-readable code for route→HTTP mapping
   * @param {number} [status] Suggested HTTP status (default 400)
   */
  constructor(message, code, status = 400) {
    super(message);
    this.name   = 'RewardEngineError';
    this.code   = code;
    this.status = status;
  }
}

// ─── Slab look-up helpers ─────────────────────────────────────────────────────

/**
 * Find the exact slab for a given postsCount milestone.
 * Returns null if no slab matches (exact match only — no fallback).
 */
function findPostSlab(slabs, milestone) {
  return slabs.find(s => s.postsCount === milestone) || null;
}

/**
 * Find the exact slab for a given referralCount milestone.
 */
function findReferralSlab(slabs, milestone) {
  return slabs.find(s => s.referralCount === milestone) || null;
}

/**
 * Find the exact slab for a given dailystreak milestone (numeric days).
 */
function findStreakSlab(slabs, daysRequired) {
  return slabs.find(s => s.dailystreak === daysRequired) || null;
}

// ─── Reward application helper ─────────────────────────────────────────────────

/**
 * Apply slab reward amounts to the user document (in-place, no save).
 * The caller must save the document inside a transaction.
 */
function applySlabToUser(user, slab) {
  user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + (slab.groceryCoupons || 0);
  user.totalShares         = (user.totalShares         || 0) + (slab.shares         || 0);
  user.totalReferralToken  = (user.totalReferralToken  || 0) + (slab.referralToken  || 0);
}

/**
 * Merge bank details onto the user document (in-place, no save).
 * Only overwrites fields that are provided in the incoming object.
 */
function mergeBankDetails(user, bankDetails) {
  if (!bankDetails) return;
  if (!user.bankDetails) user.bankDetails = {};
  if (bankDetails.accountNumber != null) user.bankDetails.accountNumber = bankDetails.accountNumber;
  if (bankDetails.ifscCode      != null) user.bankDetails.ifscCode      = bankDetails.ifscCode;
  if (bankDetails.panNumber     != null) user.bankDetails.panNumber     = bankDetails.panNumber;
}

// ─── Wallet snapshot helper ────────────────────────────────────────────────────

function walletSnapshot(user) {
  return {
    totalGroceryCoupons:   user.totalGroceryCoupons   || 0,
    totalShares:           user.totalShares            || 0,
    totalReferralToken:    user.totalReferralToken     || 0,
    redeemedReferralSlabs: user.redeemedReferralSlabs  || [],
    redeemedPostSlabs:     user.redeemedPostSlabs      || [],
    redeemedStreakSlabs:    user.redeemedStreakSlabs    || [],
  };
}

// ─── Transaction wrapper ───────────────────────────────────────────────────────

/**
 * Run `fn(session)` inside a MongoDB multi-document transaction.
 * Falls back to no-transaction mode when running against a standalone
 * MongoDB instance (replica set not available in dev).
 *
 * @param {Function} fn   Receives a mongoose ClientSession; must return a Promise.
 * @returns {*}           Whatever fn returns.
 */
async function withTransaction(fn) {
  // Detect standalone (no replica set) — transactions require a replica set
  const supportsTransactions =
    mongoose.connection.readyState === 1 &&
    mongoose.connection.db.serverConfig?.isReplicaSet?.();

  if (!supportsTransactions) {
    // Fallback: run without a session. Atomic at the document level only.
    return fn(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    session.endSession();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. REFERRAL REWARD ────────────────────────────────────────────────────────

/**
 * Claim a referral milestone reward.
 *
 * @param {string|ObjectId} userId
 * @param {number}          referralCount  The milestone to claim (e.g. 3, 6, 10, 11…30)
 * @param {object}          [bankDetails]  Optional bank details to persist
 * @returns {Promise<{ reward, wallet, planKey, milestone }>}
 * @throws  {RewardEngineError}
 */
async function claimReferralReward(userId, referralCount, bankDetails) {
  return withTransaction(async (session) => {
    const sessionOpts = session ? { session } : {};

    // ── 1. Fetch user ─────────────────────────────────────────────────────
    const user = await User.findById(userId).session(session);
    if (!user) throw new RewardEngineError('User not found.', 'USER_NOT_FOUND', 404);

    // ── 2. Eligibility gate ───────────────────────────────────────────────
    if (user.kyc?.status !== 'verified') {
      throw new RewardEngineError(
        'KYC verification required to claim rewards.',
        'KYC_NOT_VERIFIED', 403
      );
    }
    if (!user.subscription?.active) {
      throw new RewardEngineError(
        'Active subscription required to claim rewards.',
        'SUBSCRIPTION_REQUIRED', 403
      );
    }
    if (user.trustFlags?.rewardsFrozen) {
      throw new RewardEngineError(
        'Your reward payouts are temporarily suspended pending verification.',
        'REWARDS_FROZEN', 403
      );
    }

    // ── 3. Duplicate claim guard ──────────────────────────────────────────
    const alreadyClaimed = (user.redeemedReferralSlabs || []).includes(referralCount);
    if (alreadyClaimed) {
      throw new RewardEngineError(
        `Referral milestone ${referralCount} has already been claimed.`,
        'ALREADY_CLAIMED', 409
      );
    }

    // ── 4. Plan resolution ────────────────────────────────────────────────
    const planKey = getUserPlan(user);

    // ── 5. Slab look-up (exact match — no fallback) ───────────────────────
    let slabs;
    try {
      slabs = readRewards('referral', planKey);
    } catch (err) {
      throw new RewardEngineError(
        `Reward configuration not found for plan ${planKey}.`,
        'SLAB_NOT_FOUND', 500
      );
    }

    const slab = findReferralSlab(slabs, referralCount);
    if (!slab) {
      throw new RewardEngineError(
        `No referral reward configured for ${referralCount} referrals on your plan.`,
        'SLAB_NOT_FOUND', 404
      );
    }

    // ── 6. Verify the user actually has this many active referrals ─────────
    const activeReferrals = await User.countDocuments(
      { referral: user._id, 'subscription.active': true },
      sessionOpts
    );
    if (activeReferrals < referralCount) {
      throw new RewardEngineError(
        `You need ${referralCount} active referrals to claim this reward. You have ${activeReferrals}.`,
        'MILESTONE_NOT_REACHED', 400
      );
    }

    // ── 7. Apply reward ───────────────────────────────────────────────────
    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = slab;

    user.redeemedReferralSlabs.push(referralCount);
    applySlabToUser(user, slab);
    mergeBankDetails(user, bankDetails);

    // ── 8. Persist atomically ─────────────────────────────────────────────
    await user.save(sessionOpts);

    await Promise.all([
      new Activity({
        user:        user._id,
        referral:    user._id,
        type:        'referral_reward',
        slabAwarded: referralCount,
      }).save(sessionOpts),

      RewardClaim.create(
        [{ user: user._id, type: 'referral', milestone: String(referralCount) }],
        sessionOpts
      ),
    ]);

    return {
      planKey,
      milestone: referralCount,
      reward:    { groceryCoupons, shares, referralToken },
      wallet:    walletSnapshot(user),
    };
  });
}

// ── 2. POST REWARD ────────────────────────────────────────────────────────────

/**
 * Claim a post milestone reward.
 *
 * @param {string|ObjectId} userId
 * @param {number}          postMilestone  The milestone to claim (30, 70, 150…)
 * @param {object}          [bankDetails]
 * @returns {Promise<{ reward, wallet, planKey, milestone }>}
 * @throws  {RewardEngineError}
 */
async function claimPostReward(userId, postMilestone, bankDetails) {
  const PostsSchema = require('../models/Posts');

  return withTransaction(async (session) => {
    const sessionOpts = session ? { session } : {};

    const user = await User.findById(userId).session(session);
    if (!user) throw new RewardEngineError('User not found.', 'USER_NOT_FOUND', 404);

    if (user.kyc?.status !== 'verified') {
      throw new RewardEngineError('KYC verification required.', 'KYC_NOT_VERIFIED', 403);
    }
    if (!user.subscription?.active) {
      throw new RewardEngineError('Active subscription required.', 'SUBSCRIPTION_REQUIRED', 403);
    }
    if (user.trustFlags?.rewardsFrozen) {
      throw new RewardEngineError('Rewards suspended.', 'REWARDS_FROZEN', 403);
    }

    const alreadyClaimed = (user.redeemedPostSlabs || []).includes(postMilestone);
    if (alreadyClaimed) {
      throw new RewardEngineError(
        `Post milestone ${postMilestone} has already been claimed.`,
        'ALREADY_CLAIMED', 409
      );
    }

    const planKey = getUserPlan(user);

    let slabs;
    try {
      slabs = readRewards('posts', planKey);
    } catch {
      throw new RewardEngineError(`Reward config not found for plan ${planKey}.`, 'SLAB_NOT_FOUND', 500);
    }

    const slab = findPostSlab(slabs, postMilestone);
    if (!slab) {
      throw new RewardEngineError(
        `No post reward configured for ${postMilestone} posts on your plan.`,
        'SLAB_NOT_FOUND', 404
      );
    }

    const postCount = await PostsSchema.countDocuments(
      { user_id: user._id, 'moderation.status': { $ne: 'rejected' } },
      sessionOpts
    );
    if (postCount < postMilestone) {
      throw new RewardEngineError(
        `You need ${postMilestone} posts to claim this reward. You have ${postCount}.`,
        'MILESTONE_NOT_REACHED', 400
      );
    }

    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = slab;

    user.redeemedPostSlabs.push(postMilestone);
    applySlabToUser(user, slab);
    mergeBankDetails(user, bankDetails);

    await user.save(sessionOpts);

    await Promise.all([
      new Activity({
        user:        user._id,
        userpost:    user._id,
        slabAwarded: postMilestone,
      }).save(sessionOpts),

      RewardClaim.create(
        [{ user: user._id, type: 'post', milestone: String(postMilestone) }],
        sessionOpts
      ),
    ]);

    return {
      planKey,
      milestone: postMilestone,
      reward:    { groceryCoupons, shares, referralToken },
      wallet:    walletSnapshot(user),
    };
  });
}

// ── 3. STREAK REWARD ──────────────────────────────────────────────────────────

/**
 * Claim a daily streak milestone reward.
 *
 * @param {string|ObjectId} userId
 * @param {number}          daysRequired  Numeric days (30, 60, 90…)
 * @param {object}          [bankDetails]
 * @returns {Promise<{ reward, wallet, planKey, milestone, slabKey }>}
 * @throws  {RewardEngineError}
 */
async function claimStreakReward(userId, daysRequired, bankDetails) {
  return withTransaction(async (session) => {
    const sessionOpts = session ? { session } : {};

    const slabKey = `${daysRequired}days`;

    const user = await User.findById(userId).session(session);
    if (!user) throw new RewardEngineError('User not found.', 'USER_NOT_FOUND', 404);

    if (user.kyc?.status !== 'verified') {
      throw new RewardEngineError('KYC verification required.', 'KYC_NOT_VERIFIED', 403);
    }
    if (!user.subscription?.active) {
      throw new RewardEngineError('Active subscription required.', 'SUBSCRIPTION_REQUIRED', 403);
    }
    if (user.trustFlags?.rewardsFrozen) {
      throw new RewardEngineError('Rewards suspended.', 'REWARDS_FROZEN', 403);
    }

    if (!Array.isArray(user.redeemedStreakSlabs)) user.redeemedStreakSlabs = [];
    if (user.redeemedStreakSlabs.includes(slabKey)) {
      throw new RewardEngineError(
        `Streak milestone ${slabKey} has already been claimed.`,
        'ALREADY_CLAIMED', 409
      );
    }

    const planKey = getUserPlan(user);

    let slabs;
    try {
      slabs = readRewards('streak', planKey);
    } catch {
      throw new RewardEngineError(`Reward config not found for plan ${planKey}.`, 'SLAB_NOT_FOUND', 500);
    }

    const slab = findStreakSlab(slabs, daysRequired);
    if (!slab) {
      throw new RewardEngineError(
        `No streak reward configured for ${daysRequired} days on your plan.`,
        'SLAB_NOT_FOUND', 404
      );
    }

    // Count unique streak days from Activity
    const streakDocs = await Activity.find(
      { user: user._id, dailystreak: { $exists: true, $ne: null } },
      'createdAt',
      sessionOpts
    ).lean();

    const uniqueDays = new Set(
      streakDocs.map(d => new Date(d.createdAt).toISOString().split('T')[0])
    );
    if (uniqueDays.size < daysRequired) {
      throw new RewardEngineError(
        `You need ${daysRequired} streak days. You have ${uniqueDays.size}.`,
        'MILESTONE_NOT_REACHED', 400
      );
    }

    const { groceryCoupons = 0, shares = 0, referralToken = 0 } = slab;

    user.redeemedStreakSlabs.push(slabKey);
    applySlabToUser(user, slab);
    mergeBankDetails(user, bankDetails);

    await user.save(sessionOpts);

    await Promise.all([
      new Activity({ user: user._id, streakslab: slabKey }).save(sessionOpts),
      RewardClaim.create(
        [{ user: user._id, type: 'streak', milestone: slabKey }],
        sessionOpts
      ),
    ]);

    return {
      planKey,
      milestone:  daysRequired,
      slabKey,
      reward:     { groceryCoupons, shares, referralToken },
      wallet:     walletSnapshot(user),
    };
  });
}

// ── 4. UNDO REWARD (admin) ────────────────────────────────────────────────────

/**
 * Reverse a previously claimed reward slab (admin undo panel).
 * Subtracts the reward amounts and removes the slab from the redeemed list.
 *
 * @param {string|ObjectId} userId
 * @param {'referral'|'post'|'streak'} type
 * @param {number|string}   slab   Numeric milestone or slabKey string
 * @returns {Promise<boolean>} true if anything was undone, false if nothing matched
 */
async function undoReward(userId, type, slab) {
  return withTransaction(async (session) => {
    const sessionOpts = session ? { session } : {};

    const user = await User.findById(userId).session(session);
    if (!user) throw new RewardEngineError('User not found.', 'USER_NOT_FOUND', 404);

    const planKey = getUserPlan(user);
    let updated = false;

    if (type === 'referral') {
      const idx = (user.redeemedReferralSlabs || []).indexOf(Number(slab));
      if (idx === -1) return false;

      const slabs  = readRewards('referral', planKey);
      const slabObj = findReferralSlab(slabs, Number(slab));
      if (slabObj) {
        user.totalGroceryCoupons -= slabObj.groceryCoupons || 0;
        user.totalShares         -= slabObj.shares         || 0;
        user.totalReferralToken  -= slabObj.referralToken  || 0;
      }
      user.redeemedReferralSlabs.splice(idx, 1);
      updated = true;

    } else if (type === 'post') {
      const idx = (user.redeemedPostSlabs || []).indexOf(Number(slab));
      if (idx === -1) return false;

      const slabs   = readRewards('posts', planKey);
      const slabObj = findPostSlab(slabs, Number(slab));
      if (slabObj) {
        user.totalGroceryCoupons -= slabObj.groceryCoupons || 0;
        user.totalShares         -= slabObj.shares         || 0;
        user.totalReferralToken  -= slabObj.referralToken  || 0;
      }
      user.redeemedPostSlabs.splice(idx, 1);
      updated = true;

    } else if (type === 'streak') {
      // slab can be numeric (30) or string ('30days')
      const slabKey = typeof slab === 'string' && slab.endsWith('days')
        ? slab
        : `${slab}days`;
      const idx = (user.redeemedStreakSlabs || []).indexOf(slabKey);
      if (idx === -1) return false;

      const daysNum = parseInt(slabKey, 10);
      const slabs   = readRewards('streak', planKey);
      const slabObj = findStreakSlab(slabs, daysNum);
      if (slabObj) {
        user.totalGroceryCoupons -= slabObj.groceryCoupons || 0;
        user.totalShares         -= slabObj.shares         || 0;
        user.totalReferralToken  -= slabObj.referralToken  || 0;
      }
      user.redeemedStreakSlabs.splice(idx, 1);
      updated = true;

    } else {
      throw new RewardEngineError(`Unknown reward type: ${type}`, 'INVALID_TYPE', 400);
    }

    // Floor at 0 — never allow negative wallet balances
    user.totalGroceryCoupons = Math.max(0, user.totalGroceryCoupons || 0);
    user.totalShares         = Math.max(0, user.totalShares         || 0);
    user.totalReferralToken  = Math.max(0, user.totalReferralToken  || 0);

    if (updated) await user.save(sessionOpts);
    return updated;
  });
}

// ── 5. ELIGIBILITY CHECK (read-only) ─────────────────────────────────────────

/**
 * Return eligibility status without side-effects.
 * Used by GET /api/activity/reward-eligibility and the earned-rewards endpoint.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<{ eligible, rewardsFrozen, blockerCode, gates, planKey }>}
 */
async function getEligibility(userId) {
  const user = await User.findById(userId)
    .select('kyc subscription trustFlags')
    .lean();
  if (!user) throw new RewardEngineError('User not found.', 'USER_NOT_FOUND', 404);

  const kycStatus  = user.kyc?.status ?? 'not_started';
  const kycPassed  = kycStatus === 'verified';
  const subActive  = !!user.subscription?.active;
  const subExpired = subActive && user.subscription?.expiresAt
    && new Date(user.subscription.expiresAt) < new Date();
  const subPassed  = subActive && !subExpired;
  const frozen     = !!user.trustFlags?.rewardsFrozen;

  let blockerCode = null;
  if (frozen)                        blockerCode = 'REWARDS_FROZEN';
  else if (!kycPassed && !subPassed) blockerCode = 'KYC_AND_SUBSCRIPTION';
  else if (!kycPassed)               blockerCode = 'KYC_NOT_VERIFIED';
  else if (!subPassed)               blockerCode = 'SUBSCRIPTION_REQUIRED';

  return {
    eligible:      !frozen && kycPassed && subPassed,
    rewardsFrozen: frozen,
    blockerCode,
    planKey:       getUserPlan(user),
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  claimReferralReward,
  claimPostReward,
  claimStreakReward,
  undoReward,
  getEligibility,
  RewardEngineError,
  // Expose helpers for testing / simulation
  _internals: {
    findPostSlab,
    findReferralSlab,
    findStreakSlab,
    applySlabToUser,
    mergeBankDetails,
    walletSnapshot,
  },
};