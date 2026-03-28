/**
 * utils/tierCalculation/calculatePostsReward.js
 *
 * Backward-compatible wrapper. New code should use RewardEngine.claimPostReward().
 */

'use strict';

const { readRewards } = require('./rewardManager');

/**
 * @param {number} postsCount
 * @param {string} [plan='2500']
 * @returns {{ groceryCoupons, shares, referralToken } | null}
 */
function calculatePostsReward(postsCount, plan = '2500') {
  try {
    const slabs = readRewards('posts', String(plan));
    return slabs.find(s => s.postsCount === postsCount) || null;
  } catch {
    return null;
  }
}

module.exports = { calculatePostsReward };