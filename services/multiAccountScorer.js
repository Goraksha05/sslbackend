// services/multiAccountScorer.js
// Computes the MultiAccountScore for a given userId.
// MultiAccountScore = D × N × B × G  (device × network × behavior × graph density)
// Score range: 0–1. Above 0.75 triggers automated defense actions.
//
// This service is called:
//   1. On every login (quick check)
//   2. On every reward claim (gate check)
//   3. By the nightly batch job (full rescore)
//   4. By the LLM investigation agent (on-demand)
'use strict';

const DeviceFingerprint = require('../models/DeviceFingerprint');
const DeviceGraph       = require('../models/DeviceGraph');
const BehaviorVector    = require('../models/BehaviorVector');
const User              = require('../models/User');

// ── Thresholds ────────────────────────────────────────────────────────────────
const THRESHOLDS = {
  AUTO_FLAG:    0.75,
  KYC_GATE:     0.60,
  WATCHLIST:    0.45,
};

// ── Device similarity (0–1) ───────────────────────────────────────────────────
// How many other accounts share the same device fingerprint?
async function computeDeviceSimilarity(userId, fpHash) {
  if (!fpHash) return 0;

  const fp = await DeviceFingerprint.findOne({ fpHash }).lean();
  if (!fp) return 0;

  const otherAccounts = (fp.userIds || []).filter(id => String(id) !== String(userId));
  const count = otherAccounts.length;

  // Risk curve: 0 others = 0.0, 1 other = 0.4, 2 = 0.65, 3+ = 0.85+
  if (count === 0) return 0.0;
  if (count === 1) return 0.4;
  if (count === 2) return 0.65;
  return Math.min(0.55 + count * 0.1, 1.0);
}

// ── Network similarity (0–1) ──────────────────────────────────────────────────
// How many other accounts share the same /24 subnet?
async function computeNetworkSimilarity(userId, ip) {
  if (!ip) return 0;

  // Extract /24 prefix (first 3 octets for IPv4)
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;  // skip IPv6 for now
  const subnet = parts.slice(0, 3).join('.');

  // Count other user nodes that share this subnet via graph edges
  const ipNodes = await DeviceGraph.find({
    entityType: 'ip',
    entityId:   { $regex: `^${subnet}\\.` },
  }).lean();

  const sharedUserIds = new Set();
  for (const node of ipNodes) {
    for (const edge of (node.edges || [])) {
      if (edge.targetType === 'user' && String(edge.targetId) !== String(userId)) {
        sharedUserIds.add(String(edge.targetId));
      }
    }
  }

  const count = sharedUserIds.size;
  if (count === 0) return 0.0;
  if (count <= 2)  return 0.2;
  if (count <= 5)  return 0.4;
  if (count <= 10) return 0.6;
  return Math.min(0.4 + count * 0.03, 1.0);
}

// ── Behavior similarity (0–1) ─────────────────────────────────────────────────
// From the user's BehaviorVector — combines anomaly score + cluster similarity
async function computeBehaviorSimilarity(userId) {
  const vec = await BehaviorVector.findOne({ userId }).lean();
  if (!vec) return 0;

  // Use the pre-computed ML scores if available
  const anomaly = vec.anomalyScore || 0;
  const cluster = vec.clusterSimilarityScore || 0;

  // Heuristic blend
  let score = (anomaly * 0.5) + (cluster * 0.5);

  // Boost if referral burst detected
  if (vec.referralBurstScore && vec.referralBurstScore > 3) {
    score = Math.min(score + 0.2, 1.0);
  }
  // Boost for inhuman typing regularity
  if (vec.typingVelocityStdDev !== null && vec.typingVelocityStdDev < 2) {
    score = Math.min(score + 0.15, 1.0);
  }
  // Boost for scheduled logins
  if (vec.loginIntervalEntropy !== null && vec.loginIntervalEntropy < 0.5) {
    score = Math.min(score + 0.2, 1.0);
  }

  return score;
}

// ── Graph cluster density (0–1) ────────────────────────────────────────────────
// How densely connected is this user's cluster?
// Dense clusters with internal referrals = farm signal.
async function computeGraphClusterDensity(userId) {
  const node = await DeviceGraph.findOne({
    entityType: 'user',
    entityId:   String(userId),
  }).lean();

  if (!node) return 0;

  const betweenness  = node.betweennessScore  || 0;
  const pageRank     = node.pageRankScore     || 0;
  const degree       = node.degreeScore       || 0;

  // High betweenness = hub = likely farm operator account
  let score = betweenness * 0.5 + Math.min(degree / 20, 1) * 0.3 + pageRank * 0.2;

  // If the node is flagged by graph algorithms, hard-boost
  const flags = node.riskFlags || [];
  if (flags.includes('referral_loop'))       score = Math.min(score + 0.4, 1.0);
  if (flags.includes('shared_device_farm'))  score = Math.min(score + 0.3, 1.0);
  if (flags.includes('hub_account'))         score = Math.min(score + 0.35, 1.0);

  return Math.min(score, 1.0);
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Compute the full MultiAccountScore for a user.
 *
 * @param {string|ObjectId} userId
 * @param {object} context  Optional runtime context (ip, fpHash) from the triggering request
 * @returns {Promise<{
 *   score: number,
 *   tier: 'clean'|'watchlist'|'kyc_gate'|'auto_flag',
 *   breakdown: object,
 *   explanation: string
 * }>}
 */
async function computeMultiAccountScore(userId, context = {}) {
  const { ip, fpHash } = context;

  const [D, N, B, G] = await Promise.all([
    computeDeviceSimilarity(userId, fpHash),
    computeNetworkSimilarity(userId, ip),
    computeBehaviorSimilarity(userId),
    computeGraphClusterDensity(userId),
  ]);

  // Multiplicative model: all factors must be elevated for a high score.
  // This prevents a single noisy signal from triggering false positives.
  // We raise each component to 0.25 power so the product isn't too aggressive
  // when only one factor is high.
  const rawProduct = Math.pow(D * N * B * G, 0.25);  // geometric mean

  // Weighted blend: behavior + graph are stronger signals than raw device/network
  const weightedScore =
    D * 0.20 +
    N * 0.15 +
    B * 0.35 +
    G * 0.30;

  // Final score is the average of geometric mean and weighted blend
  const score = Math.min((rawProduct + weightedScore) / 2, 1.0);

  const tier =
    score >= THRESHOLDS.AUTO_FLAG  ? 'auto_flag'  :
    score >= THRESHOLDS.KYC_GATE   ? 'kyc_gate'   :
    score >= THRESHOLDS.WATCHLIST  ? 'watchlist'  :
    'clean';

  const explanation = buildExplanation(userId, { D, N, B, G, score, tier, ip, fpHash });

  return {
    score: Math.round(score * 1000) / 1000,
    tier,
    breakdown: { deviceSimilarity: D, networkSimilarity: N, behaviorSimilarity: B, graphClusterDensity: G },
    explanation,
  };
}

function buildExplanation(userId, { D, N, B, G, score, tier, ip, fpHash }) {
  const parts = [];
  parts.push(`MultiAccountScore: ${(score * 100).toFixed(1)}% (tier: ${tier})`);
  if (fpHash) parts.push(`Device FP: ${fpHash.slice(0, 8)}… (D=${D.toFixed(2)})`);
  if (ip)     parts.push(`IP: ${ip} (N=${N.toFixed(2)})`);
  parts.push(`Behavior anomaly: B=${B.toFixed(2)}`);
  parts.push(`Graph density: G=${G.toFixed(2)}`);
  return parts.join(' | ');
}

module.exports = { computeMultiAccountScore, THRESHOLDS };