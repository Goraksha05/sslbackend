/**
 * models/AdPage.js
 *
 * An Ad Page is the brand/business identity that appears on ads.
 * Think of it like a Facebook Page — it has a name, logo, category, and
 * public profile URL that viewers see when they click on an ad.
 *
 * Relationship:
 *   AdAccount (1) ──→ AdPage (many)
 *   AdCampaign references AdPage for the "Sponsored by" brand identity on the ad
 *
 * A page must be active before it can be attached to a campaign.
 */

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const AdPageSchema = new Schema(
  {
    // The Ad Account this page belongs to
    adAccount: {
      type:     Schema.Types.ObjectId,
      ref:      'AdAccount',
      required: true,
      index:    true,
    },

    // The user who owns the Ad Account (denormalised for fast queries)
    owner: {
      type:     Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      index:    true,
    },

    // Brand display name shown on ads (e.g. "Rahul's Bakery")
    pageName: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 100,
    },

    // Unique slug for deep-linking (e.g. "rahuls-bakery")
    pageSlug: {
      type:   String,
      unique: true,
    },

    // Logo URL (Cloudinary or external https)
    logoUrl: {
      type:    String,
      default: null,
    },

    // Cover image URL
    coverUrl: {
      type:    String,
      default: null,
    },

    // Short description shown below the ad
    tagline: {
      type:      String,
      trim:      true,
      maxlength: 160,
      default:   '',
    },

    // Detailed about section
    about: {
      type:      String,
      trim:      true,
      maxlength: 1000,
      default:   '',
    },

    // Business category
    category: {
      type: String,
      enum: [
        'ecommerce', 'food_beverage', 'fashion', 'tech', 'education',
        'health_wellness', 'real_estate', 'finance', 'entertainment',
        'travel', 'automotive', 'services', 'ngo', 'other',
      ],
      default: 'other',
    },

    // External website
    website: {
      type:    String,
      default: null,
      validate: {
        validator: v => !v || /^https?:\/\//i.test(v),
        message:   'website must be a valid URL',
      },
    },

    // Contact info shown on the page
    contactEmail: { type: String, default: null },
    contactPhone: { type: String, default: null },

    // Page verification status
    status: {
      type:    String,
      enum:    ['draft', 'active', 'suspended'],
      default: 'draft',
      index:   true,
    },

    // Aggregate stats (updated on campaign events)
    totalCampaigns:  { type: Number, default: 0 },
    totalImpressions: { type: Number, default: 0 },
    totalClicks:     { type: Number, default: 0 },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ── Pre-save: auto-generate pageSlug ──────────────────────────────────────────
AdPageSchema.pre('save', async function (next) {
  if (!this.pageSlug) {
    const base = this.pageName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const rand = Math.random().toString(36).slice(2, 6);
    this.pageSlug = `${base}-${rand}`;
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────
AdPageSchema.index({ adAccount: 1, status: 1 });

module.exports = mongoose.model('AdPage', AdPageSchema);