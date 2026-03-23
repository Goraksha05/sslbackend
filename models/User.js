// models/User.js
//
// FIX: The kyc sub-document was missing two fields that adminKycController.js
// writes unconditionally:
//
//   kyc.thumbnails   — { aadhaarThumb, panThumb, bankThumb, selfieThumb }
//                      Written by processFile() in submitKYC. Without this
//                      declared, Mongoose stores it as untyped Mixed data with
//                      no path-level validation, and IDE/TypeScript tooling
//                      cannot see it.
//
//   kyc.documents.selfie — The schema declared aadhaarFile, panFile,
//                      bankPassbookFile but not selfie, even though submitKYC
//                      stores selfieFile.url there.
//
// Both fields are now explicitly declared. Existing documents are unaffected —
// Mongoose reads Mixed fields normally; the new declarations just add validation
// and type coercion going forward.

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const UserSchema = new Schema({
  role: {
    type:    String,
    enum:    ['user', 'admin', 'super_admin'],
    default: 'user',
  },

  // RBAC additions
  adminRole: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'AdminRole',
    default: null,
  },
  adminPermissions: {
    type:    [String],
    default: [],
  },

  referral: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: false,
  },

  referralId: {
    type:   String,
    unique: true,
    index:  true,
    sparse: true,
  },

  name:     { type: String, required: true },
  username: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  phone:    { type: String, required: true },
  password: { type: String, required: true },

  subscription_id: { type: String },

  date: { type: Date, default: Date.now },

  sex: {
    type:    String,
    enum:    ['Male', 'Female', 'Prefered not to mention'],
    default: 'Prefered not to mention',
  },

  subscription: {
    plan:             { type: String },
    planAmount:       { type: Number },   // numeric plan key (2500 / 3500 / 4500)
    paymentId:        { type: String },
    orderId:          { type: String },
    active:           { type: Boolean, default: false },
    startDate:        { type: Date },
    expiresAt:        { type: Date },
    autoRenew:        { type: Boolean, default: false },
    activationMethod: { type: String, enum: ['paid', 'referrals', null], default: null },
    referralTarget:   { type: Number, default: 10 },
  },

  activationMethod:    { type: String, enum: ['paid', 'referrals', null], default: null },
  referralActivatedAt: { type: Date },
  referralTarget:      { type: Number, default: 10 },

  bankDetails: {
    accountNumber: { type: String },
    ifscCode:      { type: String },
    panNumber:     { type: String },
  },

  totalGroceryCoupons: { type: Number, default: 0 },
  totalShares:         { type: Number, default: 0 },
  totalReferralToken:  { type: Number, default: 0 },

  rewardedPostMilestones: { type: [Number], default: [] },
  redeemedPostSlabs:      { type: [Number], default: [] },
  redeemedReferralSlabs:  { type: [Number], default: [] },
  redeemedStreakSlabs:     { type: [String], default: [] },

  termsAccepted: { type: Boolean, default: false },
  isAdmin:       { type: Boolean, default: false },   // legacy — derived from role

  lastActive: { type: Date, default: Date.now },

  deletion: {
    requested:   { type: Boolean, default: false },
    requestedAt: { type: Date,    default: null   },
    scheduledAt: { type: Date,    default: null   },
  },

  // ── eKYC ──────────────────────────────────────────────────────────────────
  kyc: {
    status: {
      type:    String,
      enum:    ['not_started', 'required', 'submitted', 'verified', 'rejected'],
      default: 'not_started',
    },

    documents: {
      aadhaarFile:      String,
      panFile:          String,
      bankPassbookFile: String,
      // FIX: selfie was written by submitKYC but not declared in the schema
      selfie:           String,
    },

    // FIX: thumbnails sub-document was written by processFile() / submitKYC
    // but not declared in the schema, so it was stored as unvalidated Mixed data.
    thumbnails: {
      aadhaarThumb: { type: String, default: null },
      panThumb:     { type: String, default: null },
      bankThumb:    { type: String, default: null },
      selfieThumb:  { type: String, default: null },
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'user',
    },

    verifiedAt:      Date,
    rejectionReason: String,
    submittedAt:     Date,

    score: { type: Number, default: 0 },

    faceMatch: {
      score:   Number,
      matched: Boolean,
    },

    liveness: {
      live:   Boolean,
      reason: String,
    },

    ocrData: {
      aadhaar: Object,
      pan:     Object,
    },
  },

  // ── Trust flags (Fraud / Risk Engine) ────────────────────────────────────
  trustFlags: {
    riskScore:          { type: Number,  default: 0,       index: true },
    riskTier:           { type: String,  default: 'clean', index: true },
    referralAbuseScore: { type: Number,  default: 0 },

    primaryClusterId: { type: String,  default: null },
    inReferralCycle:  { type: Boolean, default: false },

    rewardsFrozen:        { type: Boolean, default: false },
    rewardsFrozenAt:      { type: Date,    default: null  },
    referralDisabled:     { type: Boolean, default: false },
    kycRequired:          { type: Boolean, default: false },
    shadowBanned:         { type: Boolean, default: false },
    onWatchlist:          { type: Boolean, default: false },
    pendingManualReview:  { type: Boolean, default: false },
    reviewQueuedAt:       { type: Date,    default: null  },

    lastEvaluatedAt:   { type: Date, default: null },
    lastGraphUpdateAt: { type: Date, default: null },
  },

}, { timestamps: true });

// ── Referral ID helpers ───────────────────────────────────────────────────────
function getInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  let initials = '';
  if (words.length >= 2)      initials = (words[0][0] || '') + (words[1][0] || '');
  else if (words.length === 1) initials = (words[0][0] || '') + (words[0][1] || '');
  else                         initials = 'UU';
  return initials.toUpperCase().replace(/[^A-Z]/g, 'X').padEnd(2, 'X').slice(0, 2);
}

async function buildReferralId(name, objectId, UserModel) {
  const initials   = getInitials(name);
  const hex        = String(objectId);
  const digitsOnly = (hex.match(/\d/g) || []).join('');
  const windows    = [];
  for (let i = 0; i <= Math.max(0, digitsOnly.length - 6); i++) {
    windows.push(digitsOnly.substr(i, 6));
  }
  if (windows.length === 0) {
    const asNum = parseInt(hex.slice(-6), 16);
    windows.push(String(asNum % 1000000).padStart(6, '0'));
  }
  for (const six of [...new Set(windows)]) {
    const candidate = `${initials}${six}`;
    const exists    = await UserModel.exists({ referralId: candidate });
    if (!exists) return candidate;
  }
  const big = parseInt(hex.slice(0, 12), 16);
  let salt  = 0;
  while (true) {
    const six       = String((big + salt) % 1000000).padStart(6, '0');
    const candidate = `${initials}${six}`;
    const exists    = await UserModel.exists({ referralId: candidate });
    if (!exists) return candidate;
    salt++;
  }
}

UserSchema.pre('save', async function (next) {
  try {
    if ((this.isNew || this.isModified('name')) && !this.referralId) {
      this.referralId = await buildReferralId(this.name, this._id, this.constructor);
    }
    next();
  } catch (err) {
    next(err);
  }
});

const User = mongoose.model('user', UserSchema);
module.exports = User;
module.exports.buildReferralId = buildReferralId;