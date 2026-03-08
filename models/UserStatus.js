// models/UserStatus.js
//
// WhatsApp-style status system.
// Each document is one status "story" posted by a user.
// A user can have multiple active statuses (up to MAX_PER_USER).
// Statuses auto-expire after EXPIRY_HOURS (default 24 h).
//
// ViewRecord sub-schema tracks who has seen each status and when,
// so we can show "seen by N people" exactly like WhatsApp.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const EXPIRY_HOURS   = 24;
const MAX_PER_USER   = 10; // guard against abuse

// ── ViewRecord ────────────────────────────────────────────────────────────────
const ViewRecordSchema = new Schema(
  {
    viewer:   { type: Schema.Types.ObjectId, ref: 'user', required: true },
    viewedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

// ── Status (single story card) ────────────────────────────────────────────────
const UserStatusSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref:  'user',
      required: true,
      index: true
    },

    // Content type: text-only card or media card
    type: {
      type: String,
      enum: ['text', 'image', 'video'],
      default: 'text'
    },

    // Text caption / status message
    text: {
      type:      String,
      maxlength: 700,   // WhatsApp cap
      default:   ''
    },

    // Background colour for text-only statuses (hex string)
    backgroundColor: {
      type:    String,
      default: '#128C7E'   // WhatsApp green
    },

    // Font style index (0 = default, matches frontend FONTS array)
    fontStyle: {
      type:    Number,
      default: 0
    },

    // Media URL (populated after upload)
    mediaUrl: {
      type:    String,
      default: ''
    },

    // Privacy: 'everyone' | 'contacts' | 'except' | 'only'
    // 'contacts' = mutual friends only (maps to Friendship.status === 'accepted')
    // 'except'   = everyone except the listed userIds in privacyExclude
    // 'only'     = only the listed userIds in privacyOnly
    privacy: {
      type:    String,
      enum:    ['everyone', 'contacts', 'except', 'only'],
      default: 'contacts'
    },

    privacyExclude: [{ type: Schema.Types.ObjectId, ref: 'user' }],
    privacyOnly:    [{ type: Schema.Types.ObjectId, ref: 'user' }],

    // Who has seen this status
    views: [ViewRecordSchema],

    // Hard expiry — TTL index will auto-delete docs after this time
    expiresAt: {
      type:    Date,
      default: () => new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000),
      index:   { expireAfterSeconds: 0 }   // MongoDB TTL index
    }
  },
  {
    timestamps: true
  }
);

// ── Compound index: fast "give me all statuses for user X, newest first" ──────
UserStatusSchema.index({ user: 1, createdAt: -1 });

// ── Instance helper: record a view (idempotent) ───────────────────────────────
UserStatusSchema.methods.recordView = function (viewerId) {
  const alreadySeen = this.views.some(v => v.viewer.toString() === viewerId.toString());
  if (!alreadySeen) {
    this.views.push({ viewer: viewerId });
    return this.save();
  }
  return Promise.resolve(this);
};

// ── Static: enforce per-user cap before insert ────────────────────────────────
UserStatusSchema.statics.enforceLimit = async function (userId) {
  const count = await this.countDocuments({ user: userId });
  if (count >= MAX_PER_USER) {
    // Delete the oldest one to make room
    const oldest = await this.findOne({ user: userId }).sort({ createdAt: 1 });
    if (oldest) await oldest.deleteOne();
  }
};

module.exports = mongoose.model('UserStatus', UserStatusSchema);
module.exports.EXPIRY_HOURS = EXPIRY_HOURS;