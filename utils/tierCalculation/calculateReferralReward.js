// utils/tierCalculation/calculateReferralReward.js
'use strict';

const { readRewards } = require('../rewardManager');

/**
 * Referral reward JSON structure (all 3 plan tiers):
 *   - Milestones 3, 6, 10  → groceryCoupons + shares + referralToken  (big milestone slabs)
 *   - Milestones 11–30     → referralToken only (200/280/360 per referral added)
 *
 * Every milestone is an INDEPENDENT claim — users must claim each one individually.
 * There is NO cumulative-highest fallback: milestone 12 is not a superset of milestone 11.
 *
 * @param {number} referralCount  - the exact milestone being claimed (e.g. 3, 6, 10, 11…30)
 * @param {string} plan           - '2500' | '3500' | '4500'
 * @returns {{ groceryCoupons, shares, referralToken, referralCount }|null}
 */
function calculateReferralReward(referralCount, plan) {
  const count = Number(referralCount);
  if (!count || isNaN(count) || count <= 0) return null;

  const slabs = readRewards('referral', plan);

  // Always exact match — every milestone in the JSON is a distinct claimable slab
  return slabs.find(s => s.referralCount === count) || null;
}

/**
 * Progress information for the referral UI.
 *
 * Returns two milestone sets:
 *   - bigMilestones: [3, 6, 10]         — shown as featured progress chips
 *   - tokenMilestones: [11, 12, …, 30]  — shown as per-referral token rewards
 *   - allMilestones: full sorted list
 *
 * Progress bar tracks position toward the next UN-claimed big milestone,
 * then switches to tracking individual token milestones beyond 10.
 *
 * @param {number} activeReferralCount - active referred users count
 * @param {string} plan
 * @param {number[]} claimedSlabs      - already-redeemed milestone numbers
 */
function getReferralSlabProgress(activeReferralCount, plan, claimedSlabs = []) {
  const count = Number(activeReferralCount) || 0;
  const slabs = readRewards('referral', plan)
    .filter(s => typeof s.referralCount === 'number')
    .sort((a, b) => a.referralCount - b.referralCount);

  const allMilestones    = slabs.map(s => s.referralCount);
  const bigMilestones    = slabs.filter(s => s.groceryCoupons > 0 || s.shares > 0).map(s => s.referralCount);
  const tokenMilestones  = slabs.filter(s => s.groceryCoupons === 0 && s.shares === 0 && s.referralToken > 0).map(s => s.referralCount);

  // Next unclaimed milestone the user hasn't reached yet
  const nextMilestone = slabs.find(s => count < s.referralCount && !claimedSlabs.includes(s.referralCount));
  const prevReached   = [...slabs].reverse().find(s => count >= s.referralCount);

  const prevCount = prevReached?.referralCount ?? 0;
  const progress  = nextMilestone
    ? Math.min(100, Math.round(((count - prevCount) / (nextMilestone.referralCount - prevCount)) * 100))
    : 100;

  // Claimable right now: reached but not yet claimed
  const claimable = slabs
    .filter(s => count >= s.referralCount && !claimedSlabs.includes(s.referralCount))
    .map(s => s.referralCount);

  return {
    allMilestones,
    bigMilestones,
    tokenMilestones,
    nextMilestone: nextMilestone?.referralCount ?? null,
    progress,
    claimable,
  };
}

module.exports = { calculateReferralReward, getReferralSlabProgress };