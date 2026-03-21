// ------- SoShoLife Trust & Safety Intelligence System ---------

// models/BehaviorVector.js
// One document per user. Updated by the nightly vectorBuilder job.
// The rolling 30-day window ensures the vector reflects recent behaviour,
// not stale data from account creation.
'use strict';

const mongoose = require('mongoose');

const BehaviorVectorSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      unique:   true,
      index:    true,
    },

    // ── Session & timing signals ───────────────────────────────────────────────
    // Shannon entropy of gaps between consecutive logins (bits).
    // High entropy = natural human variation. Near-zero = bot scheduling.
    loginIntervalEntropy: { type: Number, default: null },

    // Mean characters/second while typing in forms (collected by browser SDK).
    typingVelocityMean:   { type: Number, default: null },

    // Standard deviation of typing speed — bots are unnaturally consistent.
    typingVelocityStdDev: { type: Number, default: null },

    // Coefficient of variation for time between mouse clicks.
    clickIntervalCV:      { type: Number, default: null },

    // Entropy of scroll event intervals.
    scrollPatternEntropy: { type: Number, default: null },

    // Median session duration in seconds (P50).
    sessionDurationP50:   { type: Number, default: null },

    // ── Activity cadence signals ───────────────────────────────────────────────
    // How regularly posts are created (0 = random, 1 = perfectly regular).
    // High regularity suggests automated posting.
    postCadenceRegularity: { type: Number, default: null },

    // How many referral invitations were sent within 60-second windows (max burst).
    referralBurstScore:    { type: Number, default: null },

    // ── Navigation graph ───────────────────────────────────────────────────────
    // FNV-1a hash of the most-traversed page sequence in the last 30 days.
    // Same hash across different accounts = same navigation script.
    navigationGraphHash:   { type: String, default: null },

    // ── Derived scores (written by nightly job) ─────────────────────────────
    // Cosine similarity to the nearest suspicious cluster centroid (0–1).
    // Written by clusterSimilarityJob.js
    clusterSimilarityScore: { type: Number, default: 0 },

    // Isolation Forest anomaly score (0 = normal, 1 = highly anomalous).
    anomalyScore:           { type: Number, default: 0 },

    // Window this vector was built from
    windowStart: { type: Date, default: null },
    windowEnd:   { type: Date, default: null },

    // Number of raw events included in this vector
    eventCount:  { type: Number, default: 0 },

    // ISO timestamp the nightly job last ran for this user
    lastComputedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * Compute a simplified behavioral risk contribution (0–1).
 * Used as one factor in MultiAccountScore.
 * Full ML scoring is done server-side; this is a fast heuristic.
 */
BehaviorVectorSchema.methods.behaviouralRiskScore = function () {
  let score = 0;
  let factors = 0;

  if (this.loginIntervalEntropy !== null) {
    // Very low entropy → scheduled bot
    score += this.loginIntervalEntropy < 0.5 ? 0.8 : this.loginIntervalEntropy < 1.5 ? 0.3 : 0.0;
    factors++;
  }
  if (this.typingVelocityStdDev !== null) {
    // Inhuman consistency
    score += this.typingVelocityStdDev < 1 ? 0.9 : this.typingVelocityStdDev < 5 ? 0.3 : 0.0;
    factors++;
  }
  if (this.postCadenceRegularity !== null) {
    score += this.postCadenceRegularity > 0.9 ? 0.8 : this.postCadenceRegularity > 0.7 ? 0.4 : 0.0;
    factors++;
  }
  if (this.referralBurstScore !== null) {
    score += this.referralBurstScore > 5 ? 0.9 : this.referralBurstScore > 2 ? 0.5 : 0.0;
    factors++;
  }

  // Blend with ML-derived scores if available
  if (this.anomalyScore > 0) {
    score += this.anomalyScore;
    factors++;
  }

  return factors > 0 ? Math.min(score / factors, 1) : 0;
};

module.exports = mongoose.model('BehaviorVector', BehaviorVectorSchema);