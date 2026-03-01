// utils/tierCalculation/calculateStreakReward.js
'use strict';

const { readRewards } = require('../rewardManager');

/**
 * Streak reward JSON structure (all 3 plan tiers):
 *   Milestones: 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360 days
 *
 *   Basic  (2500): ₹500 grocery for days 30–210, ₹1000 for days 240–360
 *   Silver (3500): ₹1000 grocery for days 30–210, ₹1500 for days 240–360
 *   Gold   (4500): ₹1500 grocery for days 30–210, ₹2000 for days 240–360
 *   shares = 0, referralToken = 0 for ALL streak slabs across all plans.
 *
 * Each milestone is INDEPENDENT — must be claimed separately.
 * Streak count is measured in UNIQUE CALENDAR DAYS (deduplicated by date),
 * not raw Activity document count (which could be inflated by duplicate logs).
 *
 * @param {number} dailyStreak - the exact milestone being claimed (30|60|90|...|360)
 * @param {string} plan        - '2500' | '3500' | '4500'
 * @returns {{ dailystreak, groceryCoupons, shares, referralToken }|null}
 */
function calculateStreakReward(dailyStreak, plan) {
  const days = Number(dailyStreak);
  if (!days || isNaN(days) || days <= 0) return null;

  const slabs = readRewards('streak', plan);

  // Exact match — every 30-day increment is its own distinct slab
  return slabs.find(s => s.dailystreak === days) || null;
}

/**
 * Progress information for the streak UI.
 *
 * @param {number} uniqueStreakDays - server-confirmed unique calendar day count
 * @param {string} plan
 * @param {string[]} claimedSlabs  - already-redeemed slab keys e.g. ['30days', '60days']
 */
function getStreakSlabProgress(uniqueStreakDays, plan, claimedSlabs = []) {
  const count  = Number(uniqueStreakDays) || 0;
  const sorted = readRewards('streak', plan)
    .filter(s => typeof s.dailystreak === 'number')
    .sort((a, b) => a.dailystreak - b.dailystreak);

  const allMilestones = sorted.map(s => s.dailystreak);

  const nextMilestone = sorted.find(s => count < s.dailystreak);
  const prevReached   = [...sorted].reverse().find(s => count >= s.dailystreak);

  const prevDays = prevReached?.dailystreak ?? 0;
  const progress = nextMilestone
    ? Math.min(100, Math.round(((count - prevDays) / (nextMilestone.dailystreak - prevDays)) * 100))
    : 100;

  // Claimable: reached milestone but not yet claimed
  const claimable = sorted
    .filter(s => count >= s.dailystreak && !claimedSlabs.includes(`${s.dailystreak}days`))
    .map(s => s.dailystreak);

  return {
    allMilestones,
    nextMilestone: nextMilestone?.dailystreak ?? null,
    prevMilestone: prevReached?.dailystreak ?? 0,
    progress,
    claimable,
  };
}

module.exports = { calculateStreakReward, getStreakSlabProgress };