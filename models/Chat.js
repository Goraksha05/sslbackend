const mongoose = require("mongoose");

const chatSchema = new mongoose.Schema(
  {
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "user" }],
    lastActive: {
      type: Date,
      default: Date.now
    },
    
    // ⭐ Enhanced fields for better messenger experience
    lastMessage: {
      type: String,
      default: ""
    },
    
    lastMessageTime: {
      type: Date
    },
    
    lastMessageSender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user"
    },
    
    // Store unread count per user
    unreadCount: {
      type: Map,
      of: Number,
      default: new Map()
    },
    
    // Chat features
    isArchived: {
      type: Boolean,
      default: false
    },
    
    isPinned: {
      type: Boolean,
      default: false
    },
    
    // For group chats (future feature)
    isGroup: {
      type: Boolean,
      default: false
    },
    
    groupName: {
      type: String
    },
    
    groupAvatar: {
      type: String
    },
    
    // Chat settings
    muteUntil: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

// Index for faster queries
chatSchema.index({ members: 1, lastMessageTime: -1 });

// Method to increment unread count for a user
chatSchema.methods.incrementUnread = function(userId) {
  const currentCount = this.unreadCount.get(userId.toString()) || 0;
  this.unreadCount.set(userId.toString(), currentCount + 1);
  return this.save();
};

// Method to reset unread count for a user
chatSchema.methods.resetUnread = function(userId) {
  this.unreadCount.set(userId.toString(), 0);
  return this.save();
};

// Method to get unread count for a user
chatSchema.methods.getUnreadCount = function(userId) {
  return this.unreadCount.get(userId.toString()) || 0;
};

module.exports = mongoose.model("Chat", chatSchema);