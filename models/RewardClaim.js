/**
 * models/RewardClaim.js  (Updated)
 *
 * Added compound unique index { user, type, milestone } as the final
 * layer of duplicate-claim protection — enforces uniqueness at the DB level
 * even under race conditions or concurrent requests.
 *
 * Existing documents are unaffected. The index will be built on next startup.
 * If you have existing duplicates you'll need to clean them first:
 *
 *   db.rewardclaims.aggregate([
 *     { $group: { _id: { user: "$user", type: "$type", milestone: "$milestone" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
 *     { $match: { count: { $gt: 1 } } }
 *   ])
 */

const mongoose = require("mongoose");

const RewardClaimSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    type: {
      type: String,
      enum: ["referral", "post", "streak"],
      required: true
    },
    milestone: {
      type: String,
      required: true
    },
    claimedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

// ── NEW: Compound unique index ─────────────────────────────────────────────────
// Prevents the same (user, type, milestone) combination from ever being stored twice.
// This is belt-and-suspenders — the redeemedXxxSlabs array check in RewardEngine
// is the primary guard. This index is the last line of defense under race conditions.
RewardClaimSchema.index(
  { user: 1, type: 1, milestone: 1 },
  {
    unique: true,
    name:   'unique_user_type_milestone',
    // background: true on older Mongoose, ignored on Mongoose 8+ (always background)
  }
);

// Existing index for admin queries (keep)
RewardClaimSchema.index({ user: 1, claimedAt: -1 });
RewardClaimSchema.index({ type: 1, claimedAt: -1 });

module.exports = mongoose.model("RewardClaim", RewardClaimSchema);