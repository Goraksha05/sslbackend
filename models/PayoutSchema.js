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
    // Stores the raw unit counts for every reward currency from the slab.
    // Only groceryCoupons are a cash reward — shares and referralToken are
    // object rewards and are NOT paid out as cash (handled separately later).
    breakdown: {
      groceryCoupons: { type: Number, default: 0 },  // ₹ value of coupons (cash)
      shares:         { type: Number, default: 0 },  // units (object reward — NOT cash)
      referralToken:  { type: Number, default: 0 },  // tokens (object reward — NOT cash)
    },

    // ── Cash payout amount (grocery coupons only, in ₹) ──────────────────────
    // This is the ONLY amount that gets transferred to the user's bank account.
    // Shares and referral tokens are non-cash object rewards and are held until
    // a separate redemption flow (to be built) handles them.
    cashAmountINR: {
      type:     Number,
      required: true,
      default:  0,
    },

    // ── Object rewards held (non-cash, informational only) ───────────────────
    // Populated at payout creation time so admins can see what was held.
    // Will be cleared / consumed once the shares/tokens redemption flow ships.
    objectRewardsHeld: {
      sharesHeld:        { type: Number, default: 0 }, // units NOT paid in cash
      referralTokenHeld: { type: Number, default: 0 }, // tokens NOT paid in cash
    },

    // ── Legacy total field (kept for backward compatibility) ─────────────────
    // Previously held groceryCoupons + shares×₹1 + tokens×₹1.
    // Now equals cashAmountINR (grocery coupons only).
    // Will be removed in a future migration — always use cashAmountINR for
    // financial calculations going forward.
    totalAmountINR: {
      type:     Number,
      required: true,
    },

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

    notes:         { type: String, default: '' },
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