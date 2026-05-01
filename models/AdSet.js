/**
 * models/AdSet.js
 *
 * An Ad Set belongs to a Campaign and defines:
 *   - Audience targeting (age, gender, cities, interests, platform gates)
 *   - Placement (feed, story, sidebar)
 *   - Schedule (start/end dates, optional day-parting)
 *   - Budget allocation (optional per-set daily budget cap)
 *
 * Hierarchy:
 *   AdAccount → AdCampaign → AdSet → AdCreative
 */

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Day-parting sub-schema ─────────────────────────────────────────────────────
// Optional: restrict ad delivery to specific hours on specific days.
const DayPartSchema = new Schema(
  {
    day:       { type: Number, min: 0, max: 6 },   // 0=Sun … 6=Sat
    startHour: { type: Number, min: 0, max: 23 },
    endHour:   { type: Number, min: 0, max: 23 },
  },
  { _id: false }
);

// ── Main schema ────────────────────────────────────────────────────────────────
const AdSetSchema = new Schema(
  {
    // ── Hierarchy ─────────────────────────────────────────────────────────────
    campaign: {
      type:     Schema.Types.ObjectId,
      ref:      'AdCampaign',
      required: true,
      index:    true,
    },
    adAccount: {
      type:     Schema.Types.ObjectId,
      ref:      'AdAccount',
      required: true,
      index:    true,
    },
    owner: {
      type:     Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      index:    true,
    },

    // ── Identity ──────────────────────────────────────────────────────────────
    name: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 100,
    },

    // ── Audience Targeting ────────────────────────────────────────────────────
    targeting: {
      ageMin:      { type: Number, default: null },
      ageMax:      { type: Number, default: null },
      genders:     {
        type:    [String],
        enum:    ['Male', 'Female', 'Prefered not to mention'],
        default: [],
      },
      cities:             { type: [String], default: [] },
      states:             { type: [String], default: [] },
      interests:          { type: [String], default: [] },
      subscriptionPlans:  { type: [Number], default: [] },
      kycVerifiedOnly:    { type: Boolean, default: false },
      minStreakDays:       { type: Number,  default: 0 },
    },

    // ── Placement ─────────────────────────────────────────────────────────────
    placements: {
      type:    [String],
      enum:    ['feed', 'story', 'sidebar', 'notifications', 'search'],
      default: ['feed'],
    },

    // ── Schedule ──────────────────────────────────────────────────────────────
    startDate:   { type: Date, required: true },
    endDate:     { type: Date, required: true },
    dayParting:  { type: [DayPartSchema], default: [] },

    // ── Budget ────────────────────────────────────────────────────────────────
    // Optional daily cap for this set (must be ≤ campaign.dailyBudget if set).
    dailyBudgetCap: { type: Number, default: null },
    bidPerClick:    { type: Number, default: null },   // overrides campaign if set

    // ── Status ────────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['active', 'paused', 'draft', 'completed', 'rejected'],
      default: 'draft',
      index:   true,
    },

    // ── Counters (denormalised for dashboard) ─────────────────────────────────
    impressionCount: { type: Number, default: 0 },
    clickCount:      { type: Number, default: 0 },
    adCount:         { type: Number, default: 0 },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

AdSetSchema.index({ campaign: 1, status: 1 });
AdSetSchema.index({ adAccount: 1, createdAt: -1 });

module.exports = mongoose.model('AdSet', AdSetSchema);