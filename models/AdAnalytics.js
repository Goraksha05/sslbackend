/**
 * models/AdAnalytics.js
**/

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const DailyStatSchema = new Schema(
  {
    date:        { type: String, required: true }, // 'YYYY-MM-DD'
    impressions: { type: Number, default: 0 },
    clicks:      { type: Number, default: 0 },
    spentINR:    { type: Number, default: 0 },
  },
  { _id: false }
);

const AdAnalyticsSchema = new Schema(
  {
    ad_id: {
      type:     Schema.Types.ObjectId,
      ref:      'AdCreative',
      required: true,
      unique:   true,
      index:    true,
    },

    campaign_id: {
      type:  Schema.Types.ObjectId,
      ref:   'AdCampaign',
      index: true,
    },

    impressions:      { type: Number, default: 0 },
    clicks:           { type: Number, default: 0 },
    totalSpentINR:    { type: Number, default: 0 },

    lastImpressionAt: { type: Date, default: null },
    lastClickAt:      { type: Date, default: null },

    // Rolling daily breakdown (last 30 days kept by a TTL-style trim)
    dailyStats: { type: [DailyStatSchema], default: [] },
  },
  { timestamps: true }
);

// Virtual CTR
AdAnalyticsSchema.virtual('ctr').get(function () {
  return this.impressions > 0
    ? Math.round((this.clicks / this.impressions) * 10000) / 10000
    : 0;
});

/**
 * Upsert today's daily stat entry.
 * Called from adsController after impression/click events.
 */
AdAnalyticsSchema.methods.recordEvent = function (type, spentINR = 0) {
  const today = new Date().toISOString().split('T')[0];
  let day = this.dailyStats.find(d => d.date === today);
  if (!day) {
    this.dailyStats.push({ date: today, impressions: 0, clicks: 0, spentINR: 0 });
    day = this.dailyStats[this.dailyStats.length - 1];
  }
  if (type === 'impression') {
    this.impressions++;
    day.impressions++;
    this.lastImpressionAt = new Date();
  } else if (type === 'click') {
    this.clicks++;
    day.clicks++;
    day.spentINR += spentINR;
    this.totalSpentINR += spentINR;
    this.lastClickAt = new Date();
  }
  // Keep only last 30 days
  if (this.dailyStats.length > 30) {
    this.dailyStats.sort((a, b) => b.date.localeCompare(a.date));
    this.dailyStats = this.dailyStats.slice(0, 30);
  }
};

module.exports = mongoose.model('AdAnalytics', AdAnalyticsSchema);