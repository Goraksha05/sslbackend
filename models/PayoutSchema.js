// models/PayoutSchema.js  (UPDATED)
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES:
//   NEW — userRequested {Boolean}
//     true  → user explicitly requested this payout via POST /redeem-grocery-coupons
//     false → admin created this payout for a slab reward (post/referral/streak)
//
//   This flag separates two distinct flows in the admin panel:
//     • Pending Claims tab: shows slab reward claims + user-requested grocery redemptions
//     • Unredeemed Wallets tab: shows wallet balances NOT yet requested by user
//
//   Admin ONLY pays what the user explicitly requested (userRequested:true).
//   Unredeemed wallet balances stay pending until the user submits a request.
// ─────────────────────────────────────────────────────────────────────────────

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
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'RewardClaim',
    },

    // ── Reward metadata ───────────────────────────────────────────────────────
    rewardType: {
      type:     String,
      enum:     ['post', 'referral', 'streak', 'grocery_redeem'],
      required: true,
    },
    milestone: {
      type: mongoose.Schema.Types.Mixed,
    },
    planKey: {
      type: String,
    },

    // ── User-requested flag ────────────────────────────────────────────────
    // NEW: true = user explicitly clicked "Redeem" in their panel.
    //      false (default) = admin-created payout for a slab reward.
    //
    // Admin should only PAY payouts where userRequested === true.
    // Non-requested grocery coupon balances sit in "Unredeemed Wallets" tab
    // and are only paid AFTER the user submits a redemption request.
    userRequested: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // ── INR breakdown ─────────────────────────────────────────────────────────
    breakdown: {
      groceryCoupons: { type: Number, default: 0 },
      shares:         { type: Number, default: 0 },
      referralToken:  { type: Number, default: 0 },
    },

    // ── Cash payout amount (only grocery coupons, in ₹) ──────────────────────
    // This is the ONLY amount transferred to the user's bank.
    // Shares and referral tokens are non-cash object rewards (held separately).
    cashAmountINR: {
      type:     Number,
      required: true,
      default:  0,
    },

    // ── Object rewards held (non-cash) ────────────────────────────────────────
    objectRewardsHeld: {
      sharesHeld:        { type: Number, default: 0 },
      referralTokenHeld: { type: Number, default: 0 },
    },

    // ── Legacy total field (kept for backward compat — equals cashAmountINR) ──
    totalAmountINR: {
      type:     Number,
      required: true,
    },

    // ── Bank details snapshot at payout creation time ─────────────────────────
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

    transactionRef: { type: String, default: null },
    notes:          { type: String, default: '' },
    failureReason:  { type: String, default: null },

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

// Index for user-requested grocery redemption queries
PayoutSchema.index({ rewardType: 1, userRequested: 1, status: 1 });
PayoutSchema.index({ user: 1, rewardType: 1, userRequested: 1, status: 1 });

const Payout = mongoose.models.Payout || mongoose.model('Payout', PayoutSchema);
module.exports = Payout;