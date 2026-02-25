const rewardSlabs = require('../config/postsRewards.json');

function calculatePostsReward(postsCount) {
  const matched = rewardSlabs.slice().reverse().find(slab => postsCount >= slab.postsCount);
  return matched || { groceryCoupons: 0, shares: 0, referralToken: 0 };
}

function getPostSlabProgress(postsCount) {
  const sorted = [...rewardSlabs].sort((a, b) => a.postsCount - b.postsCount);
  let reached = null, next = null;
  for (let i = 0; i < sorted.length; i++) {
    if (postsCount >= sorted[i].postsCount) {
      reached = sorted[i];
    } else {
      next = sorted[i];
      break;
    }
  }
  return { reached, next };
}

module.exports = {
  calculatePostsReward,
  getPostSlabProgress
};
