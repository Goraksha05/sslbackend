// utils/calculateReferralReward.js
const { readRewards } = require('../rewardManager');

function calculateReferralReward(referralCount, plan) {
  const rewardSlabs = readRewards('referral', plan);
  const matched = [...rewardSlabs].reverse().find(s => referralCount >= s.referralCount);
  return matched || { groceryCoupons: 0, shares: 0, referralToken: 0 };
}

function getReferralSlabProgress(referralCount, plan) {
  const sorted = readRewards('referral', plan).sort((a, b) => a.referralCount - b.referralCount);
  let reached = null, next = null;
  for (const slab of sorted) {
    if (referralCount >= slab.referralCount) reached = slab;
    else { next = slab; break; }
  }
  return { reached, next };
}

module.exports = { calculateReferralReward, getReferralSlabProgress };
