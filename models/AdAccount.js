/**
 * models/AdAccount.js
 *
 * An Ad Account is the root billing + identity entity for advertising on SoShoLife.
 * Every campaign must belong to an Ad Account.
 *
 * An Ad Account is:
 *   - Created by a SoShoLife user (owner) using their own email OR referralId
 *   - Separate from the user's social profile — it is a "business identity"
 *   - Required before any campaign, creative, or page can be created
 *   - Subject to admin approval before it can run ads (status: pending → active)
 *
 * One user may own multiple Ad Accounts (e.g. for different businesses).
 * An Ad Account may have multiple Ad Pages linked to it.
 * Campaigns are scoped to an Ad Account (NOT directly to a user).
 */

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Billing address sub-schema ────────────────────────────────────────────────
const BillingSchema = new Schema(
  {
    businessName: { type: String, trim: true, maxlength: 150, default: '' },
    gstin:        { type: String, trim: true, maxlength: 15,  default: null },
    address:      { type: String, trim: true, maxlength: 300, default: '' },
    city:         { type: String, trim: true, maxlength: 80,  default: '' },
    state:        { type: String, trim: true, maxlength: 80,  default: '' },
    pincode:      { type: String, trim: true, maxlength: 10,  default: '' },
    panNumber:    { type: String, trim: true, maxlength: 10,  default: null },
  },
  { _id: false }
);

// ── Main schema ────────────────────────────────────────────────────────────────
const AdAccountSchema = new Schema(
  {
    // The SoShoLife user who owns this account
    owner: {
      type:     Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      index:    true,
    },

    // Human-readable account name (e.g. "Rahul's Bakery Ads")
    accountName: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 120,
    },

    // Unique advertiser handle — auto-generated, e.g. "ACC-RK200341"
    adsAccountId: {
      type:   String,
      unique: true,
    },

    // The email used to register this ad account (can be same as profile email)
    email: {
      type:     String,
      required: true,
      trim:     true,
      lowercase: true,
    },

    // The referralId of the owner at time of account creation (for linking)
    referralId: {
      type:  String,
      index: true,
    },

    // Industry / category — used for ad policy checks
    industry: {
      type: String,
      enum: [
        'ecommerce', 'food_beverage', 'fashion', 'tech', 'education',
        'health_wellness', 'real_estate', 'finance', 'entertainment',
        'travel', 'automotive', 'services', 'ngo', 'other',
      ],
      default: 'other',
    },

    // Account-level lifetime spend cap (₹). null = no cap.
    lifetimeSpendCapINR: { type: Number, default: null },

    // Account-level currency (always INR for now)
    currency: { type: String, default: 'INR' },

    // Billing information
    billing: { type: BillingSchema, default: () => ({}) },

    // Account status — must be 'active' to run campaigns
    status: {
      type:    String,
      enum:    ['pending_review', 'active', 'suspended', 'rejected'],
      default: 'pending_review',
      index:   true,
    },

    // Admin review
    reviewedBy:    { type: Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedAt:    { type: Date, default: null },
    reviewNote:    { type: String, default: null },

    // Aggregate financials (updated on each transaction)
    totalDepositedINR: { type: Number, default: 0 },
    totalSpentINR:     { type: Number, default: 0 },
    balanceINR:        { type: Number, default: 0 },

    // Soft-delete flag
    isDeleted:   { type: Boolean, default: false },
    deletedAt:   { type: Date, default: null },
  },
  { timestamps: true }
);

// ── Pre-save: auto-generate adsAccountId ──────────────────────────────────────
const { v4: uuidv4 } = require('uuid');

AdAccountSchema.pre('save', async function (next) {
  if (!this.adsAccountId) {
    this.adsAccountId = `ACC-${uuidv4().slice(0, 6).toUpperCase()}`;
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────
AdAccountSchema.index({ owner: 1, status: 1 });
// AdAccountSchema.index({ adsAccountId: 1 });

module.exports = mongoose.model('AdAccount', AdAccountSchema);