// utils/tierCalculation/calculatePostsReward.js
'use strict';

const { readRewards } = require('../rewardManager');

/**
 * Post reward JSON structure (all 3 plan tiers):
 *   Milestones: 30, 70, 150, 300, 600, 1000 posts
 *
 *   Basic  (2500): 500/500/500/1000/1200/1500 grocery coupons | 10/10/10/20/20/20 shares
 *   Silver (3500): 1000/1000/1000/1500/1800/2200 coupons      | 15/15/15/30/30/30 shares
 *   Gold   (4500): 2000/2000/2000/2500/3000/3500 coupons      | 20/20/20/40/40/40 shares
 *
 * Each milestone is INDEPENDENT — the reward is tied to that specific milestone,
 * NOT to the user's total post count at time of claim.
 * Claiming 70-post slab ALWAYS gives that slab's value, even if user has 500 posts.
 *
 * @param {number} postsCount - the exact milestone being claimed (30|70|150|300|600|1000)
 * @param {string} plan       - '2500' | '3500' | '4500'
 * @returns {{ groceryCoupons, shares, referralToken, postsCount }|null}
 */
function calculatePostsReward(postsCount, plan) {
  const count = Number(postsCount);
  if (!count || isNaN(count) || count <= 0) return null;

  const slabs = readRewards('posts', plan);

  // Strict exact match — do NOT fall back to highest-reached
  // because each milestone has its own distinct reward value
  return slabs.find(s => s.postsCount === count) || null;
}

/**
 * Progress information for the posts UI.
 *
 * @param {number} currentPostCount - user's actual total approved post count
 * @param {string} plan
 * @param {number[]} claimedSlabs   - already-redeemed milestone numbers
 */
function getPostSlabProgress(currentPostCount, plan, claimedSlabs = []) {
  const count  = Number(currentPostCount) || 0;
  const sorted = readRewards('posts', plan)
    .filter(s => typeof s.postsCount === 'number')
    .sort((a, b) => a.postsCount - b.postsCount);

  const allMilestones = sorted.map(s => s.postsCount);

  const nextMilestone = sorted.find(s => count < s.postsCount);
  const prevReached   = [...sorted].reverse().find(s => count >= s.postsCount);

  const prevCount = prevReached?.postsCount ?? 0;
  const progress  = nextMilestone
    ? Math.min(100, Math.round(((count - prevCount) / (nextMilestone.postsCount - prevCount)) * 100))
    : 100;

  const claimable = sorted
    .filter(s => count >= s.postsCount && !claimedSlabs.includes(s.postsCount))
    .map(s => s.postsCount);

  return {
    allMilestones,
    nextMilestone: nextMilestone?.postsCount ?? null,
    prevMilestone: prevReached?.postsCount ?? 0,
    progress,
    claimable,
  };
}

module.exports = { calculatePostsReward, getPostSlabProgress };