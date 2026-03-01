// backend/models/Notification.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const NotificationSchema = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },

    url: {
      type: String,
    },

    message: {
      type: String,
      required: true,
    },

    type: {
      type: String,
      enum: [
        // 👥 Friends
        "friend_request",
        "friend_accept",
        "friend_decline",

        // 👤 Referrals
        "referral_signup",
        "referral_reward",
        "referral_activation",

        // 📝 Posts
        "post_reward",
        "post_deleted",
        "comment",
        "like",

        // 🔥 Streaks
        "streak_reward",
        "daily_streak",
        "streak_reminder",

        // 💳 Payments
        "payment_success",
        "auto_renew",

        // ⏳ Subscription
        "expiry_reminder_7d",
        "expiry_reminder_1d",

        // 🛠️ Fallback
        "custom",
      ],
      required: true,
    },

    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────────────

// Primary query pattern: fetch a user's notifications sorted by recency
NotificationSchema.index({ user: 1, createdAt: -1 });

// Unread count queries and mark-all-read operations
NotificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

// TTL: automatically delete notifications older than 90 days
// Change `expireAfterSeconds` to adjust retention (90d = 7_776_000s)
NotificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7_776_000, name: "ttl_90d" }
);

module.exports = mongoose.model("Notification", NotificationSchema);