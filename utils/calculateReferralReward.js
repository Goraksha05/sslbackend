const rewardSlabs = require('../config/referralRewards.json');

function calculateReferralReward(referralCount) {
  const matched = rewardSlabs.slice().reverse().find(slab => referralCount >= slab.referralCount);
  return matched || { groceryCoupons: 0, shares: 0, referralToken: 0 };
}

function getReferralSlabProgress(referralCount) {
  const sorted = [...rewardSlabs].sort((a, b) => a.referralCount - b.referralCount);
  let reached = null, next = null;
  for (let i = 0; i < sorted.length; i++) {
    if (referralCount >= sorted[i].referralCount) {
      reached = sorted[i];
    } else {
      next = sorted[i];
      break;
    }
  }
  return { reached, next };
}

module.exports = {
  calculateReferralReward,
  getReferralSlabProgress
};
