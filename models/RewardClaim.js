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

module.exports = mongoose.model("RewardClaim", RewardClaimSchema);
