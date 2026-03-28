'use strict';
 
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ModerationSchema = new Schema({
      // ── Content moderation strikes ──────────────────────────────────────────
    // Incremented by adminPostModerationController each time a post is
    // rejected or deleted by an admin. At STRIKE_THRESHOLD (3) the user is
    // auto-flagged (shadowBanned + pendingManualReview = true).
    moderationStrikes: { type: Number, default: 0 },
    strikeLog: [
      {
        at:     { type: Date   },
        by:     { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
        reason: { type: String },
      },
    ],

    // ── Account block (set by adminPostModerationController.blockUser) ────────
    // Check `user.blocked === true` in your login controllers and return 403.
    blocked:       { type: Boolean, default: false },
    blockedAt:     { type: Date,    default: null  },
    blockedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    blockedReason: { type: String,  default: null  },

  },{ timestamps: true });

  module.exports = mongoose.model('Moderation', ModerationSchema);