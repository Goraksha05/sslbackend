/**
 * models/AdTargeting.js
**/

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const AdTargetingSchema = new Schema(
  {
    campaign_id: {
      type:     Schema.Types.ObjectId,
      ref:      'AdCampaign',
      required: true,
      unique:   true,   // one config per campaign
      index:    true,
    },

    // ── Demographics ─────────────────────────────────────────────────────────
    ageMin: { type: Number, default: null },
    ageMax: { type: Number, default: null },
    genders: {
      type:    [String],
      enum:    ['Male', 'Female', 'Prefered not to mention'],
      default: [],   // empty = all genders
    },

    // ── Geography ────────────────────────────────────────────────────────────
    // Matches against Profile.currentcity / Profile.hometown
    cities: { type: [String], default: [] },  // e.g. ['Mumbai', 'Pune']
    states: { type: [String], default: [] },  // future-use

    // ── Interests / tags ─────────────────────────────────────────────────────
    interests: { type: [String], default: [] },

    // ── Platform eligibility gates ───────────────────────────────────────────
    // Only show to users on these subscription plan amounts (empty = all plans)
    subscriptionPlans: {
      type:    [Number],
      default: [],
      // e.g. [2500, 3500] = Basic + Silver users only
    },

    // Only show to KYC-verified users (safer for financial product ads)
    kycVerifiedOnly: { type: Boolean, default: false },

    // Minimum active streak days — rewards engagement
    minStreakDays: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdTargeting', AdTargetingSchema);