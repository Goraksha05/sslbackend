/**
 * models/AdCreative.js  (UPDATED)
 *
 * Now linked to AdSet (parent) in addition to AdCampaign.
 *
 * Hierarchy:  AdAccount → AdCampaign → AdSet → AdCreative
 *
 * CHANGES from original:
 *  - Added `adSet` field (ObjectId ref to AdSet) — required
 *  - Added `adName` for human-readable creative label
 *  - Added `format` enum (single_image, carousel, video, text_only)
 *  - Added `carouselCards` sub-array for carousel format
 *  - Added `trackingParams` for UTM-style tracking
 *  - Added `previewUrl` (Cloudinary optimised thumbnail)
 *  - `campaign_id` kept for backward compatibility — still populated
 */

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Carousel card sub-schema ──────────────────────────────────────────────────
const CarouselCardSchema = new Schema(
  {
    image:   { type: String, default: null },
    headline:{ type: String, trim: true, maxlength: 80, default: '' },
    cta:     { type: String, trim: true, maxlength: 50, default: '' },
    link:    {
      type:    String,
      validate: {
        validator: v => !v || /^https:\/\//i.test(v),
        message: 'Carousel card link must use HTTPS',
      },
    },
  },
  { _id: false }
);

// ── Tracking params sub-schema ────────────────────────────────────────────────
const TrackingSchema = new Schema(
  {
    utmSource:   { type: String, default: '' },
    utmMedium:   { type: String, default: '' },
    utmCampaign: { type: String, default: '' },
    utmContent:  { type: String, default: '' },
    customParams:{ type: Map, of: String, default: {} },
  },
  { _id: false }
);

// ── Main schema ────────────────────────────────────────────────────────────────
const AdCreativeSchema = new Schema(
  {
    // ── Hierarchy ───────────────────────────────────────────────────────────
    adSet: {
      type:     Schema.Types.ObjectId,
      ref:      'AdSet',
      required: true,
      index:    true,
    },
    campaign_id: {
      type:     Schema.Types.ObjectId,
      ref:      'AdCampaign',
      required: true,
      index:    true,
    },
    adAccount: {
      type:     Schema.Types.ObjectId,
      ref:      'AdAccount',
      index:    true,
    },

    // ── Identity ──────────────────────────────────────────────────────────────
    adName: {
      type:      String,
      trim:      true,
      maxlength: 100,
      default:   '',
    },

    // ── Format ────────────────────────────────────────────────────────────────
    format: {
      type:    String,
      enum:    ['single_image', 'carousel', 'video', 'text_only'],
      default: 'single_image',
    },

    // ── Content ───────────────────────────────────────────────────────────────
    mediaType: {
      type:    String,
      enum:    ['image', 'video', 'text'],
      default: 'image',
    },
    image:          { type: String, default: null },
    video:          { type: String, default: null },
    previewUrl:     { type: String, default: null },   // thumbnail / preview
    text:           { type: String, trim: true, maxlength: 280 },
    headline:       { type: String, trim: true, maxlength: 80,  default: '' },
    description:    { type: String, trim: true, maxlength: 200, default: '' },
    altText:        { type: String, trim: true, maxlength: 120, default: '' },
    cta:            { type: String, trim: true, maxlength: 50 },
    link: {
      type:     String,
      required: true,
      validate: {
        validator: v => /^https:\/\//i.test(v),
        message:   'Ad link must use HTTPS',
      },
    },

    // ── Carousel (only populated when format === 'carousel') ─────────────────
    carouselCards: { type: [CarouselCardSchema], default: [] },

    // ── Tracking ──────────────────────────────────────────────────────────────
    tracking: { type: TrackingSchema, default: () => ({}) },

    // ── Status ────────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['active', 'paused', 'rejected', 'draft'],
      default: 'draft',
      index:   true,
    },

    // ── Denormalised counters ──────────────────────────────────────────────────
    impressionCount: { type: Number, default: 0 },
    clickCount:      { type: Number, default: 0 },
  },
  { timestamps: true }
);

AdCreativeSchema.index({ campaign_id: 1, status: 1 });
AdCreativeSchema.index({ adSet: 1, status: 1 });

module.exports = mongoose.model('AdCreative', AdCreativeSchema);