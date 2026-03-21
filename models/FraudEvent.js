// ------- SoShoLife Trust & Safety Intelligence System ---------

// models/FraudEvent.js
// Immutable audit record written every time the trust system makes a decision.
// Every automated action MUST produce a FraudEvent. This is the explainability
// layer — admins can always read why any action was taken.
'use strict';

const mongoose = require('mongoose');

const FraudEventSchema = new mongoose.Schema(
  {
    userId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'user',
      index: true,
    },

    // Which event on the platform triggered the scoring run
    triggerEvent: {
      type: String,
      enum: [
        'login',
        'register',
        'post_create',
        'referral_create',
        'reward_claim',
        'subscription_activate',
        'payout_request',
        'manual_review',
        'nightly_batch',
      ],
      required: true,
    },

    // Scores from each sub-model at the time of this event
    scores: {
      deviceSimilarity:   { type: Number, default: null },  // 0–1
      networkSimilarity:  { type: Number, default: null },  // 0–1
      behaviorSimilarity: { type: Number, default: null },  // 0–1
      graphClusterDensity:{ type: Number, default: null },  // 0–1
      multiAccountScore:  { type: Number, default: null },  // composite 0–1
      referralAbuse:      { type: Number, default: null },  // 0–1
      velocityScore:      { type: Number, default: null },  // 0–1
      aggregateRiskScore: { type: Number, required: true }, // final 0–1
    },

    // Cluster membership at time of event
    clusterIds: [String],

    // Human-readable explanation string
    // Example: "MultiAccountScore 0.83: Device FP abc123 shared by 4 accounts
    //           (cluster-1872). Referral burst: 6 invites in 90s."
    explanation: { type: String, required: true },

    // What the system did (empty = observation only, no action taken)
    actionsTriggered: {
      type: [String],
      default: [],
      // Possible: 'freeze_rewards', 'disable_referral_link', 'require_kyc',
      //           'shadow_ban', 'queue_manual_review', 'flag_watchlist'
    },

    // Was this event reviewed and resolved by a human admin?
    resolved: { type: Boolean, default: false },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    resolvedAt:  { type: Date, default: null },
    resolution:  { type: String, default: null }, // 'false_positive' | 'confirmed_fraud' | 'escalated'

    // Snapshot of the raw event payload (for replay / investigation)
    eventPayload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    // Never allow updates — this is an immutable audit log.
    // Use resolved/resolvedBy/resolution fields to close out events.
  }
);

FraudEventSchema.index({ userId: 1, createdAt: -1 });
FraudEventSchema.index({ 'scores.aggregateRiskScore': -1 });
FraudEventSchema.index({ resolved: 1, createdAt: -1 });
FraudEventSchema.index({ actionsTriggered: 1 });

module.exports = mongoose.model('FraudEvent', FraudEventSchema);