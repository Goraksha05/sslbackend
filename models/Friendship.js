// models/FriendshipSchema.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const FriendshipSchema = new Schema(
  {
    requester: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'blocked'],
      default: 'pending'
    }
  },
  {
    timestamps: true // ✅ adds createdAt & updatedAt automatically
  }
);

// ✅ Prevent duplicate friend requests (one-way only)
FriendshipSchema.index({ requester: 1, recipient: 1 }, { unique: true });

// ✅ Optional: prevent mutual duplicates (A → B and B → A)
// This requires compound logic in route, but for safety, we’ll check in route anyway

// 🔒 Optional: ensure only one status is 'accepted' for a given user-pair (future optimization)

module.exports = mongoose.model('Friendship', FriendshipSchema);
