/**
 * utils/tierCalculation/calculateStreakReward.js
 *
 * Backward-compatible wrapper. New code should use RewardEngine.claimStreakReward().
 */

'use strict';

const { readRewards } = require('./rewardManager');

/**
 * @param {number} daysRequired   Numeric days (30, 60, 90…)
 * @param {string} [plan='2500']
 * @returns {{ groceryCoupons, shares, referralToken } | null}
 */
function calculateStreakReward(daysRequired, plan = '2500') {
  try {
    const slabs = readRewards('streak', String(plan));
    return slabs.find(s => s.dailystreak === daysRequired) || null;
  } catch {
    return null;
  }
}

module.exports = { calculateStreakReward };