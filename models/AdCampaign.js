/**
 * models/AdCampaign.js 
**/

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const AdCampaignSchema = new Schema(
  {
    // ── Ownership hierarchy ──────────────────────────────────────────────────
    // The Ad Account this campaign runs under (REQUIRED)
    adAccount: {
      type:     Schema.Types.ObjectId,
      ref:      'AdAccount',
      required: true,
      index:    true,
    },

    adsAccountId: {
      type:   String,
      unique: true,
    },

    // The brand page shown as the sponsor on ads (REQUIRED)
    adPage: {
      type:     Schema.Types.ObjectId,
      ref:      'AdPage',
      required: true,
      index:    true,
    },

    // Denormalised owner (same as adAccount.owner) — kept for backward compat
    user_id: {
      type:     Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      index:    true,
    },

    campaignName: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 120,
    },

    objective: {
      type:    String,
      enum:    ['traffic', 'engagement', 'awareness', 'leads', 'conversions'],
      default: 'traffic',
    },

    // ── Budget ───────────────────────────────────────────────────────────────
    budget:          { type: Number, required: true, min: 100 },
    dailyBudget:     { type: Number, default: null },
    remainingBudget: { type: Number, required: true },
    totalSpent:      { type: Number, default: 0 },
    currency:        { type: String, default: 'INR' },

    bidPerClick:     { type: Number, default: 1, min: 0.5 },
    bidStrategy:     {
      type:    String,
      enum:    ['manual_cpc', 'lowest_cost', 'target_cpa'],
      default: 'manual_cpc',
    },

    // ── Schedule ─────────────────────────────────────────────────────────────
    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },

    // ── Status lifecycle ─────────────────────────────────────────────────────
    // pending_review → active (admin approval)
    // active         → paused (advertiser or budget exhausted)
    // active/paused  → completed (endDate passed)
    // pending_review → rejected (admin rejection)
    status: {
      type:    String,
      enum:    ['pending_review', 'active', 'paused', 'completed', 'rejected'],
      default: 'pending_review',
      index:   true,
    },

    pauseReason:   { type: String, default: null },

    // ── Admin review ─────────────────────────────────────────────────────────
    reviewedBy:    { type: Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedAt:    { type: Date, default: null },
    approvedAt:    { type: Date, default: null },
    rejectionNote: { type: String, default: null },

    // ── Denormalised counters ─────────────────────────────────────────────────
    impressionCount: { type: Number, default: 0 },
    clickCount:      { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
AdCampaignSchema.index({ status: 1, startDate: 1, endDate: 1, remainingBudget: 1 });
AdCampaignSchema.index({ adAccount: 1, createdAt: -1 });
AdCampaignSchema.index({ user_id: 1, createdAt: -1 });
AdCampaignSchema.index({ adPage: 1, status: 1 });

module.exports = mongoose.model('AdCampaign', AdCampaignSchema);