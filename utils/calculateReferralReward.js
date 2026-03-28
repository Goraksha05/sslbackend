/**
 * utils/tierCalculation/calculateReferralReward.js
 *
 * Thin wrapper that delegates to RewardEngine internals + rewardManager.
 * Kept for backward compatibility with any callers that import this directly
 * (undoRewardRedemption.js, simulationEngine.js, financeAndPayoutController.js).
 *
 * IMPORTANT: New code should use RewardEngine.claimReferralReward() instead.
 */

'use strict';

const { readRewards } = require('./rewardManager');

/**
 * @param {number} referralCount
 * @param {string} [plan='2500']
 * @returns {{ groceryCoupons, shares, referralToken } | null}
 */
function calculateReferralReward(referralCount, plan = '2500') {
  try {
    const slabs = readRewards('referral', String(plan));
    return slabs.find(s => s.referralCount === referralCount) || null;
  } catch {
    return null;
  }
}

module.exports = { calculateReferralReward };