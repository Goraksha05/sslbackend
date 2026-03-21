// ------- SoShoLife Trust & Safety Intelligence System ---------

// models/DeviceGraph.js
// Graph node document. Each user, device, IP, and payment account
// is a node. Edges are stored as embedded arrays for fast O(1) lookups.
// Graph algorithm results (clusters, centrality) are written by nightly jobs.
'use strict';

const mongoose = require('mongoose');

// ── Edge sub-schema ────────────────────────────────────────────────────────────
const EdgeSchema = new mongoose.Schema(
  {
    targetType: {
      type: String,
      enum: ['user', 'device', 'ip', 'payment', 'phone'],
      required: true,
    },
    targetId:   { type: String, required: true },  // string to support both ObjectId and IP strings
    relation: {
      type: String,
      enum: ['login', 'payment', 'referral', 'session', 'registration'],
      required: true,
    },
    weight:   { type: Number, default: 1 },   // frequency / strength
    firstSeen: { type: Date, default: Date.now },
    lastSeen:  { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main node schema ──────────────────────────────────────────────────────────
const DeviceGraphSchema = new mongoose.Schema(
  {
    entityType: {
      type:     String,
      enum:     ['user', 'device', 'ip', 'payment', 'phone'],
      required: true,
      index:    true,
    },
    // For 'user': MongoDB ObjectId as string
    // For 'device': DeviceFingerprint fpHash
    // For 'ip': dotted-decimal IP string
    // For 'payment': Razorpay account/payment id
    // For 'phone': E.164 phone string
    entityId: {
      type:     String,
      required: true,
      index:    true,
    },

    edges: [EdgeSchema],

    // ── Cluster membership (written by nightly graph job) ──────────────────────
    // A cluster is a connected component identified by the algorithm.
    // One node can belong to multiple clusters at different granularities.
    clusterIds:      { type: [String], default: [] },
    primaryClusterId: { type: String, default: null },

    // ── Centrality scores (written by nightly graph job) ──────────────────────
    // PageRank — influential nodes in the referral network
    pageRankScore:        { type: Number, default: 0 },
    // Betweenness — bridges between clusters (likely hub accounts)
    betweennessScore:     { type: Number, default: 0 },
    // Degree — raw number of distinct connections
    degreeScore:          { type: Number, default: 0 },

    // ── Risk flags ─────────────────────────────────────────────────────────────
    riskFlags: {
      type: [String],
      default: [],
      // 'shared_device_farm'   — device node linked to 3+ user nodes
      // 'referral_loop'        — cycle detected in referral edges
      // 'payout_overlap'       — same payment node for 2+ users
      // 'ip_cluster'           — IP shared by 5+ accounts
      // 'hub_account'          — betweenness > 0.7 (central to abuse network)
    },

    lastGraphUpdateAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Compound index so we can quickly fetch a node by type+id
DeviceGraphSchema.index({ entityType: 1, entityId: 1 }, { unique: true });

// ── Helper: upsert an edge ─────────────────────────────────────────────────────
DeviceGraphSchema.methods.addEdge = function (targetType, targetId, relation) {
  const existing = this.edges.find(
    e => e.targetType === targetType && e.targetId === String(targetId) && e.relation === relation
  );
  if (existing) {
    existing.weight++;
    existing.lastSeen = new Date();
  } else {
    this.edges.push({ targetType, targetId: String(targetId), relation });
  }
};

// ── Static: upsert a node ──────────────────────────────────────────────────────
DeviceGraphSchema.statics.upsertNode = async function (entityType, entityId) {
  return this.findOneAndUpdate(
    { entityType, entityId: String(entityId) },
    { $setOnInsert: { entityType, entityId: String(entityId) } },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('DeviceGraph', DeviceGraphSchema);