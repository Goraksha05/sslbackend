// backend/schema_models/Message.js
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  chatId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Chat", 
    required: true,
    index: true 
  },
  
  sender: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "user", 
    required: true 
  },
  
  text: { 
    type: String 
  },
  
  mediaUrl: { 
    type: String 
  },
  
  mediaType: { 
    type: String,
    enum: ['image', 'video', 'audio', 'document', null]
  },
  
  thumbnailUrl: {
    type: String // For video thumbnails
  },
  
  seenBy: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "user" 
  }],
  
  isDeleted: { 
    type: Boolean, 
    default: false 
  },
  
  deletedBy: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "user" 
  }],
  
  // ⭐ Reply functionality
  replyTo: {
    messageId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Message" 
    },
    text: { 
      type: String 
    },
    senderName: { 
      type: String 
    },
    mediaType: {
      type: String
    }
  },
  
  // ⭐ Reactions (emoji responses)
  reactions: [{
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "user" 
    },
    emoji: { 
      type: String 
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Message status
  deliveredTo: [{
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "user" 
    },
    deliveredAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // For forwarded messages
  isForwarded: {
    type: Boolean,
    default: false
  },
  
  // For edited messages
  isEdited: {
    type: Boolean,
    default: false
  },
  
  editedAt: {
    type: Date
  },
  
  // Message priority (for future features)
  priority: {
    type: String,
    enum: ['normal', 'high', 'urgent'],
    default: 'normal'
  }
  
}, { 
  timestamps: true 
});

// Indexes for performance
messageSchema.index({ chatId: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ 'replyTo.messageId': 1 });

// Virtual for checking if message has media
messageSchema.virtual('hasMedia').get(function() {
  return !!(this.mediaUrl && this.mediaType);
});

// Method to check if user has seen the message
messageSchema.methods.isSeenBy = function(userId) {
  return this.seenBy.some(id => id.toString() === userId.toString());
};

// Method to add reaction
messageSchema.methods.addReaction = function(userId, emoji) {
  // Remove existing reaction from this user
  this.reactions = this.reactions.filter(
    r => r.userId.toString() !== userId.toString()
  );
  
  // Add new reaction if emoji provided
  if (emoji) {
    this.reactions.push({ userId, emoji });
  }
  
  return this.save();
};

// Method to remove reaction
messageSchema.methods.removeReaction = function(userId) {
  this.reactions = this.reactions.filter(
    r => r.userId.toString() !== userId.toString()
  );
  return this.save();
};

// Static method to get unread count for a chat
messageSchema.statics.getUnreadCount = async function(chatId, userId) {
  return await this.countDocuments({
    chatId,
    sender: { $ne: userId },
    seenBy: { $ne: userId },
    isDeleted: false
  });
};

// Pre-save hook to update chat's last message
messageSchema.pre('save', async function(next) {
  if (this.isNew && !this.isDeleted) {
    try {
      const Chat = mongoose.model('Chat');
      await Chat.findByIdAndUpdate(this.chatId, {
        lastMessage: this.text || `[${this.mediaType || 'Media'}]`,
        lastMessageTime: this.createdAt,
        lastMessageSender: this.sender,
        lastActive: Date.now()
      });
    } catch (err) {
      console.error('Failed to update chat last message:', err);
    }
  }
  next();
});

module.exports = mongoose.model("Message", messageSchema);