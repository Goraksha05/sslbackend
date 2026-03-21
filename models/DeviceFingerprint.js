// ------- SoShoLife Trust & Safety Intelligence System ---------

// models/DeviceFingerprint.js
// Stores one document per unique browser/device fingerprint hash.
// Each login attempt upserts this record and links the userId.
'use strict';

const mongoose = require('mongoose');

const DeviceFingerprintSchema = new mongoose.Schema(
  {
    // SHA-256 of (userAgent + screenRes + colorDepth + timezone + languages + gpuRenderer)
    fpHash: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },

    // All user IDs ever seen using this fingerprint
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'user' }],

    // Raw signals collected from the browser
    signals: {
      userAgent:    String,
      screenRes:    String,   // e.g. "1920x1080"
      colorDepth:   Number,
      timezone:     String,   // e.g. "Asia/Kolkata"
      languages:    [String],
      platform:     String,
      cookieEnabled: Boolean,
      gpuRenderer:  String,   // from WebGL RENDERER string
      gpuVendor:    String,
      fonts:        [String], // detected installed fonts
      plugins:      [String],
      touchSupport: Boolean,
      hardwareConcurrency: Number,
      deviceMemory: Number,
    },

    // Risk signals derived from this fingerprint
    riskFlags: {
      type: [String],
      default: [],
      // Possible values:
      // 'multi_account_device' — linked to 3+ accounts
      // 'known_vpn_fingerprint' — matches known VPN profile
      // 'headless_browser'      — WebGL/font signals suggest Puppeteer/Playwright
      // 'script_automation'     — interaction patterns match bot
    },

    // Convenience counter
    accountCount: { type: Number, default: 1 },

    lastSeenAt:   { type: Date, default: Date.now },
    firstSeenAt:  { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Auto-update accountCount when userIds changes
DeviceFingerprintSchema.pre('save', function (next) {
  this.accountCount = (this.userIds || []).length;
  next();
});

// Add risk flag if too many accounts share this device
DeviceFingerprintSchema.methods.evaluateRisk = function () {
  const flags = new Set(this.riskFlags || []);
  if (this.accountCount >= 3) flags.add('multi_account_device');
  if (this.accountCount >= 5) flags.add('high_account_farm_risk');
  // Headless browser heuristics
  if (!this.signals?.gpuRenderer || this.signals.gpuRenderer === '') {
    flags.add('headless_browser');
  }
  this.riskFlags = [...flags];
};

module.exports = mongoose.model('DeviceFingerprint', DeviceFingerprintSchema);