// services/referralAbuseScorer.js
// Computes ReferralAbuseProbability (0–1) for a given userId.
// Checks referral tree structure, timing, cluster overlap, and payment patterns.
//
// Called:
//   1. When a referral is created (real-time gate)
//   2. When a referral-based reward is claimed
//   3. By the nightly batch job
'use strict';

const User          = require('../models/User');
const DeviceGraph   = require('../models/DeviceGraph');
const BehaviorVector = require('../models/BehaviorVector');
const RewardClaim   = require('../models/RewardClaim');

// ── Feature extraction ────────────────────────────────────────────────────────

/**
 * How many referrals did this user make in the last N minutes?
 */
async function getReferralBurstRate(userId, windowMinutes = 5) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  return User.countDocuments({
    referral:  userId,
    date:      { $gte: since },
  });
}

/**
 * How many of this user's referrals share device fingerprints with the referrer?
 * Returns fraction 0–1.
 */
async function getDeviceOverlapFraction(userId) {
  // Find all referred users
  const referredUsers = await User.find({ referral: userId }).select('_id').lean();
  if (referredUsers.length === 0) return 0;

  const referredIds = referredUsers.map(u => String(u._id));

  // Get graph node for this user to find their device edges
  const referrerNode = await DeviceGraph.findOne({
    entityType: 'user',
    entityId:   String(userId),
  }).lean();

  if (!referrerNode) return 0;

  const referrerDevices = (referrerNode.edges || [])
    .filter(e => e.targetType === 'device')
    .map(e => e.targetId);

  if (referrerDevices.length === 0) return 0;

  // Check how many referred users share these devices
  let sharedCount = 0;
  for (const referredId of referredIds) {
    const referredNode = await DeviceGraph.findOne({
      entityType: 'user',
      entityId:   referredId,
    }).lean();
    if (!referredNode) continue;

    const referredDevices = (referredNode.edges || [])
      .filter(e => e.targetType === 'device')
      .map(e => e.targetId);

    const overlap = referredDevices.some(d => referrerDevices.includes(d));
    if (overlap) sharedCount++;
  }

  return sharedCount / referredUsers.length;
}

/**
 * What fraction of this user's referred users activated subscriptions
 * within 10 minutes of registration? (Classic ghost account signal.)
 */
async function getInstantActivationFraction(userId) {
  const referredUsers = await User.find({ referral: userId })
    .select('date subscription')
    .lean();

  if (referredUsers.length === 0) return 0;

  const WINDOW_MS = 10 * 60 * 1000;
  let instantCount = 0;
  for (const u of referredUsers) {
    if (!u.subscription?.startDate || !u.date) continue;
    const gap = new Date(u.subscription.startDate) - new Date(u.date);
    if (gap <= WINDOW_MS) instantCount++;
  }

  return instantCount / referredUsers.length;
}

/**
 * Referral tree depth from this user as root (BFS, max 5 levels).
 * Deep trees with fast spread = pyramid scheme signal.
 */
async function getReferralTreeDepth(userId) {
  const visited = new Set([String(userId)]);
  const queue   = [[String(userId), 0]];
  let maxDepth  = 0;

  while (queue.length > 0) {
    const [current, depth] = queue.shift();
    if (depth >= 5) continue;  // cap at 5 levels to avoid N+1

    const children = await User.find({ referral: current }).select('_id').lean();
    for (const child of children) {
      const id = String(child._id);
      if (!visited.has(id)) {
        visited.add(id);
        maxDepth = Math.max(maxDepth, depth + 1);
        queue.push([id, depth + 1]);
      }
    }
  }

  return maxDepth;
}

/**
 * What fraction of reward claims for this user were made within 1 hour of
 * becoming eligible? (Legitimate users spread claims over days/weeks.)
 */
async function getClaimSpeedScore(userId) {
  const claims = await RewardClaim.find({ user: userId })
    .sort({ claimedAt: 1 })
    .lean();

  if (claims.length < 2) return 0;

  let fastClaims = 0;
  for (const claim of claims) {
    // We don't know exact eligibility time, but consecutive claims within 30 min
    // of each other is suspicious — legitimate users don't batch-claim at 2am
    const prev = claims[claims.indexOf(claim) - 1];
    if (!prev) continue;
    const gap = new Date(claim.claimedAt) - new Date(prev.claimedAt);
    if (gap < 30 * 60 * 1000) fastClaims++;
  }

  return fastClaims / (claims.length - 1);
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param {string|ObjectId} userId
 * @returns {Promise<{
 *   score: number,
 *   features: object,
 *   explanation: string
 * }>}
 */
async function computeReferralAbuseScore(userId) {
  const [
    burstRate,
    deviceOverlap,
    instantActivation,
    treeDepth,
    claimSpeed,
  ] = await Promise.all([
    getReferralBurstRate(userId, 5),
    getDeviceOverlapFraction(userId),
    getInstantActivationFraction(userId),
    getReferralTreeDepth(userId),
    getClaimSpeedScore(userId),
  ]);

  // Also pull behavior vector referral burst
  const vec = await BehaviorVector.findOne({ userId }).lean();
  const vecBurst = vec?.referralBurstScore || 0;

  // Weighted scoring
  let score = 0;

  // Burst rate in 5 min window: >3 = very suspicious
  score += Math.min(burstRate / 5, 1.0)          * 0.25;
  // Device overlap: >50% = very suspicious
  score += Math.min(deviceOverlap * 2, 1.0)       * 0.25;
  // Instant activation: >40% = suspicious
  score += Math.min(instantActivation * 2.5, 1.0) * 0.20;
  // Tree depth > 3 = unusual for organic growth
  score += Math.min((treeDepth - 1) / 4, 1.0)     * 0.15;
  // Claim speed
  score += claimSpeed                              * 0.10;
  // Vector burst
  score += Math.min(vecBurst / 5, 1.0)             * 0.05;

  score = Math.min(score, 1.0);

  const explanation = [
    `ReferralAbuseScore: ${(score * 100).toFixed(1)}%`,
    `5-min burst: ${burstRate} referrals`,
    `Device overlap: ${(deviceOverlap * 100).toFixed(0)}%`,
    `Instant activation: ${(instantActivation * 100).toFixed(0)}%`,
    `Tree depth: ${treeDepth}`,
    `Claim speed score: ${(claimSpeed * 100).toFixed(0)}%`,
  ].join(' | ');

  return {
    score: Math.round(score * 1000) / 1000,
    features: { burstRate, deviceOverlap, instantActivation, treeDepth, claimSpeed },
    explanation,
  };
}

module.exports = { computeReferralAbuseScore };