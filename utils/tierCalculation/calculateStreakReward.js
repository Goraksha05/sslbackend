// utils/calculateStreakReward.js
const { readRewards } = require('../rewardManager');

function calculateStreakReward(dailyStreak, plan) {
  const rewardSlabs = readRewards('streak', plan);
  return rewardSlabs.find(x => x.dailystreak === dailyStreak)
      || { groceryCoupons: 0, shares: 0, referralToken: 0 };
}

function getStreakSlabProgress(streakCount, plan) {
  const sorted = readRewards('streak', plan).sort((a, b) => a.dailystreak - b.dailystreak);
  let reached = null, next = null;
  for (const slab of sorted) {
    if (streakCount >= slab.dailystreak) reached = slab;
    else { next = slab; break; }
  }
  return { reached, next };
}

module.exports = { calculateStreakReward, getStreakSlabProgress };
