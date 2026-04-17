const mongoose = require('mongoose');
const { Schema } = mongoose;

const PayoutSchema = new Schema(
  {
    // ── Who ──────────────────────────────────────────────────────────────────
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      index:    true,
    },

    // ── Source claim ─────────────────────────────────────────────────────────
    rewardClaim: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'RewardClaim',
      index: false, // indexed via unique index below
    },

    // ── Reward metadata ───────────────────────────────────────────────────────
    rewardType: {
      type:     String,
      enum:     ['post', 'referral', 'streak', 'grocery_redeem'],
      required: true,
    },
    milestone: {
      type: mongoose.Schema.Types.Mixed, // number (posts/referrals) or string (e.g. "30days")
    },
    planKey: {
      type: String, // '2500' | '3500' | '4500'
    },

    // ── INR breakdown (all in ₹) ──────────────────────────────────────────────
    breakdown: {
      groceryCoupons: { type: Number, default: 0 },  // ₹ value of coupons
      shares:         { type: Number, default: 0 },  // units × ₹1
      referralToken:  { type: Number, default: 0 },  // tokens × ₹1
    },
    totalAmountINR: { type: Number, required: true }, // sum of all three above

    // ── Bank / transfer details (populated at payout time) ───────────────────
    bankDetails: {
      accountNumber: { type: String, default: null },
      ifscCode:      { type: String, default: null },
      panNumber:     { type: String, default: null },
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['pending', 'processing', 'paid', 'failed', 'on_hold'],
      default: 'pending',
      index:   true,
    },

    // Reference ID from external payment gateway (Razorpay payout, NEFT ref, etc.)
    transactionRef: { type: String, default: null },

    notes:       { type: String, default: '' },
    failureReason: { type: String, default: null },

    // ── Admin trail ───────────────────────────────────────────────────────────
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'user',
    },
    processedAt: { type: Date, default: null },
    paidAt:      { type: Date, default: null },
  },
  { timestamps: true }
);

// Prevent double-processing the same RewardClaim
PayoutSchema.index({ rewardClaim: 1 }, { unique: true, sparse: true });

const Payout = mongoose.models.Payout || mongoose.model('Payout', PayoutSchema);
module.exports = Payout;
