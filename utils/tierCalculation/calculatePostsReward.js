// utils/calculatePostsReward.js
const { readRewards } = require('../rewardManager');

function calculatePostsReward(postsCount, plan) {
  const rewardSlabs = readRewards('posts', plan);
  const matched = [...rewardSlabs].reverse().find(s => postsCount >= s.postsCount);
  return matched || { groceryCoupons: 0, shares: 0, referralToken: 0 };
}

function getPostSlabProgress(postsCount, plan) {
  const sorted = readRewards('posts', plan).sort((a, b) => a.postsCount - b.postsCount);
  let reached = null, next = null;
  for (const slab of sorted) {
    if (postsCount >= slab.postsCount) reached = slab;
    else { next = slab; break; }
  }
  return { reached, next };
}

module.exports = { calculatePostsReward, getPostSlabProgress };
