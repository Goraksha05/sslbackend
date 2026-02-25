// backend/routes/chat.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Chat = require("../models/Chat");
const Message = require("../models/Message");
const fetchUser = require("../middleware/fetchuser");

// ✅ Create or find 1:1 chat
router.post("/", fetchUser, async (req, res) => {
  try {
    const { receiverId } = req.body;
    const senderId = req.user.id;

    if (!receiverId || !senderId) {
      return res.status(400).json({ message: "Missing sender or receiver ID" });
    }

    let chat = await Chat.findOne({ 
      members: { $all: [senderId, receiverId] },
      isGroup: { $ne: true } 
    });
    
    if (!chat) {
      chat = await Chat.create({ 
        members: [senderId, receiverId],
        unreadCount: new Map([[senderId, 0], [receiverId, 0]])
      });
    }

    await chat.populate("members", "name email username profileavatar lastActive");
    res.status(200).json(chat);
  } catch (err) {
    console.error("❌ Chat POST failed:", err.message);
    res.status(500).json({ message: "Something went wrong on the server." });
  }
});

// ✅ Get all chats for a user
router.get("/:userId", fetchUser, async (req, res) => {
  try {
    const chats = await Chat.find({ members: req.params.userId })
      .populate("members", "name _id email username profileavatar lastActive")
      .populate("lastMessageSender", "name")
      .sort({ lastMessageTime: -1 }); // Most recent first

    // Add unread count to each chat
    const chatsWithUnread = chats.map(chat => {
      const chatObj = chat.toObject();
      chatObj.unreadCount = chat.getUnreadCount(req.params.userId);
      return chatObj;
    });

    res.json(chatsWithUnread);
  } catch (err) {
    console.error("❌ Failed to load chats:", err.message);
    res.status(500).json({ message: "Could not load chats." });
  }
});

// ✅ Get all messages in a chat
router.get("/messages/:chatId", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;

    const messages = await Message.find({
      chatId: req.params.chatId,
      deletedBy: { $ne: userId }
    })
      .populate("sender", "name _id profileavatar")
      .populate("replyTo.messageId", "text sender")
      .sort({ createdAt: 1 });

    res.status(200).json(messages);
  } catch (err) {
    console.error(`❌ Failed to fetch messages: ${err.message}`);
    res.status(500).json({ message: "Could not retrieve messages." });
  }
});

// ⭐ Get online status of chat members
router.get("/online-status/:chatId", fetchUser, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId)
      .populate("members", "name lastActive");
    
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Consider user online if active within last 5 minutes
    const ONLINE_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
    
    const membersStatus = chat.members.map(member => {
      const lastActiveTime = new Date(member.lastActive).getTime();
      const isOnline = (Date.now() - lastActiveTime) < ONLINE_THRESHOLD;
      
      return {
        _id: member._id,
        name: member.name,
        isOnline,
        lastActive: member.lastActive
      };
    });

    res.json({ members: membersStatus });
  } catch (err) {
    console.error("❌ Failed to get online status:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Mark chat as read (reset unread count)
router.put("/mark-read/:chatId", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const chatId = req.params.chatId;

    // Mark all unseen messages as seen
    await Message.updateMany(
      { 
        chatId,
        sender: { $ne: userId },
        seenBy: { $ne: userId }
      },
      { $addToSet: { seenBy: userId } }
    );

    // Reset unread count in chat
    const chat = await Chat.findById(chatId);
    if (chat) {
      await chat.resetUnread(userId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to mark as read:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Get unread count for a chat
router.get("/unread/:chatId", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const chatId = req.params.chatId;

    const count = await Message.getUnreadCount(chatId, userId);

    res.json({ unreadCount: count });
  } catch (err) {
    console.error("❌ Failed to get unread count:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Pin/Unpin chat
router.put("/pin/:chatId", fetchUser, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Check if user is a member
    if (!chat.members.includes(req.user.id)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    chat.isPinned = !chat.isPinned;
    await chat.save();

    res.json({ 
      success: true, 
      isPinned: chat.isPinned 
    });
  } catch (err) {
    console.error("❌ Failed to pin chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Archive/Unarchive chat
router.put("/archive/:chatId", fetchUser, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Check if user is a member
    if (!chat.members.includes(req.user.id)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    chat.isArchived = !chat.isArchived;
    await chat.save();

    res.json({ 
      success: true, 
      isArchived: chat.isArchived 
    });
  } catch (err) {
    console.error("❌ Failed to archive chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Mute/Unmute chat
router.put("/mute/:chatId", fetchUser, async (req, res) => {
  try {
    const { duration } = req.body; // duration in hours, or null to unmute
    const chat = await Chat.findById(req.params.chatId);
    
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Check if user is a member
    if (!chat.members.includes(req.user.id)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    if (duration) {
      const muteUntil = new Date();
      muteUntil.setHours(muteUntil.getHours() + duration);
      chat.muteUntil = muteUntil;
    } else {
      chat.muteUntil = null;
    }

    await chat.save();

    res.json({ 
      success: true, 
      muteUntil: chat.muteUntil 
    });
  } catch (err) {
    console.error("❌ Failed to mute chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Delete chat (for current user only)
router.delete("/:chatId", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const chatId = req.params.chatId;

    // Delete all messages in this chat for this user
    await Message.updateMany(
      { chatId },
      { $addToSet: { deletedBy: userId } }
    );

    // If both members have deleted, remove the chat entirely
    const chat = await Chat.findById(chatId);
    if (chat) {
      const allMessagesDeleted = await Message.countDocuments({
        chatId,
        deletedBy: { $all: chat.members }
      });

      const totalMessages = await Message.countDocuments({ chatId });

      if (allMessagesDeleted === totalMessages && chat.members.length === 2) {
        await Chat.findByIdAndDelete(chatId);
        await Message.deleteMany({ chatId });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ⭐ Search messages in a chat
router.get("/search/:chatId", fetchUser, async (req, res) => {
  try {
    const { query } = req.query;
    const userId = req.user.id;

    if (!query) {
      return res.status(400).json({ message: "Search query required" });
    }

    const messages = await Message.find({
      chatId: req.params.chatId,
      deletedBy: { $ne: userId },
      text: { $regex: query, $options: 'i' }
    })
      .populate("sender", "name profileavatar")
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(messages);
  } catch (err) {
    console.error("❌ Search failed:", err);
    res.status(500).json({ message: "Search failed" });
  }
});

module.exports = router;