// backend/routes/chat.js
//
// ── Bugs fixed in this version ────────────────────────────────────────────────
//
// BUG 1 — Route ordering: GET /:userId shadows all later GET routes (CRITICAL)
//   Express matches routes top-to-bottom. Because GET /:userId was declared
//   first, every subsequent GET route like GET /messages/:chatId,
//   GET /online-status/:chatId, GET /unread/:chatId, GET /search/:chatId
//   was UNREACHABLE — they were all matched as /:userId with userId equal to
//   the literal string "messages", "online-status", "unread", or "search".
//
//   Fix: all specific GET routes (with a fixed path segment) are declared
//   BEFORE GET /:userId. The rule is: specific routes before parametric ones.
//
// BUG 2 — GET /:userId uses req.params.userId instead of req.user.id
//   Any authenticated user could fetch any other user's chat list by changing
//   the URL parameter. fetchUser puts the verified identity in req.user.id.
//
//   Fix: use req.user.id for the DB query. The URL param is still accepted for
//   backward-compatibility with the frontend but is now IGNORED for the query.
//
// BUG 3 — unreadCount Map serialization after toObject()
//   chat.toObject() converts the Mongoose Map to a plain JS object keyed by
//   string. chat.getUnreadCount() calls this.unreadCount.get(...) — but after
//   toObject() the field is no longer a Map, so get() throws. The fix is to
//   call getUnreadCount() on the Mongoose document BEFORE toObject().

const express  = require("express");
const router   = express.Router();
const Chat     = require("../models/Chat");
const Message  = require("../models/Message");
const fetchUser = require("../middleware/fetchuser");

// ─── POST / — Create or find a 1:1 chat ──────────────────────────────────────
router.post("/", fetchUser, async (req, res) => {
  try {
    const { receiverId } = req.body;
    const senderId = req.user.id;

    if (!receiverId) {
      return res.status(400).json({ message: "Missing receiverId" });
    }

    let chat = await Chat.findOne({
      members:  { $all: [senderId, receiverId] },
      isGroup:  { $ne: true },
    });

    if (!chat) {
      chat = await Chat.create({
        members:     [senderId, receiverId],
        unreadCount: new Map([[senderId, 0], [receiverId, 0]]),
      });
    }

    await chat.populate("members", "name email username profileavatar lastActive");
    res.status(200).json(chat);
  } catch (err) {
    console.error("❌ Chat POST failed:", err.message);
    res.status(500).json({ message: "Something went wrong on the server." });
  }
});

// ─── PUT /mark-read/:chatId ───────────────────────────────────────────────────
router.put("/mark-read/:chatId", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;

    await Message.updateMany(
      { chatId, sender: { $ne: userId }, seenBy: { $ne: userId } },
      { $addToSet: { seenBy: userId } }
    );

    const chat = await Chat.findById(chatId);
    if (chat) await chat.resetUnread(userId);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to mark as read:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── PUT /pin/:chatId ─────────────────────────────────────────────────────────
router.put("/pin/:chatId", fetchUser, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ message: "Chat not found" });

    if (!chat.members.map(String).includes(req.user.id)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    chat.isPinned = !chat.isPinned;
    await chat.save();
    res.json({ success: true, isPinned: chat.isPinned });
  } catch (err) {
    console.error("❌ Failed to pin chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── PUT /archive/:chatId ─────────────────────────────────────────────────────
router.put("/archive/:chatId", fetchUser, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ message: "Chat not found" });

    if (!chat.members.map(String).includes(req.user.id)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    chat.isArchived = !chat.isArchived;
    await chat.save();
    res.json({ success: true, isArchived: chat.isArchived });
  } catch (err) {
    console.error("❌ Failed to archive chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── PUT /mute/:chatId ────────────────────────────────────────────────────────
router.put("/mute/:chatId", fetchUser, async (req, res) => {
  try {
    const { duration } = req.body;
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ message: "Chat not found" });

    if (!chat.members.map(String).includes(req.user.id)) {
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
    res.json({ success: true, muteUntil: chat.muteUntil });
  } catch (err) {
    console.error("❌ Failed to mute chat:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── DELETE /:chatId ──────────────────────────────────────────────────────────
router.delete("/:chatId", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;

    await Message.updateMany({ chatId }, { $addToSet: { deletedBy: userId } });

    const chat = await Chat.findById(chatId);
    if (chat) {
      const allDeleted   = await Message.countDocuments({ chatId, deletedBy: { $all: chat.members } });
      const totalMessages = await Message.countDocuments({ chatId });
      if (allDeleted === totalMessages && chat.members.length === 2) {
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

// ─── GET /online-status/:chatId ───────────────────────────────────────────────
// NOTE: must be declared BEFORE GET /:userId or Express will swallow it.
router.get("/online-status/:chatId", fetchUser, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId).populate("members", "name lastActive");
    if (!chat) return res.status(404).json({ message: "Chat not found" });

    const THRESHOLD = 5 * 60 * 1000;
    const membersStatus = chat.members.map((m) => ({
      _id:        m._id,
      name:       m.name,
      isOnline:   (Date.now() - new Date(m.lastActive).getTime()) < THRESHOLD,
      lastActive: m.lastActive,
    }));

    res.json({ members: membersStatus });
  } catch (err) {
    console.error("❌ Failed to get online status:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── GET /unread/:chatId ──────────────────────────────────────────────────────
// NOTE: must be declared BEFORE GET /:userId.
router.get("/unread/:chatId", fetchUser, async (req, res) => {
  try {
    const count = await Message.getUnreadCount(req.params.chatId, req.user.id);
    res.json({ unreadCount: count });
  } catch (err) {
    console.error("❌ Failed to get unread count:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── GET /search/:chatId ──────────────────────────────────────────────────────
// NOTE: must be declared BEFORE GET /:userId.
router.get("/search/:chatId", fetchUser, async (req, res) => {
  try {
    const { query } = req.query;
    const userId = req.user.id;

    if (!query) return res.status(400).json({ message: "Search query required" });

    const messages = await Message.find({
      chatId:    req.params.chatId,
      deletedBy: { $ne: userId },
      text:      { $regex: query, $options: "i" },
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

// ─── GET /:userId — Get all chats for the authenticated user ──────────────────
//
// BUG 2 FIX: query uses req.user.id (verified identity), not req.params.userId.
//   The URL param is kept for frontend compatibility but is not trusted.
//
// BUG 3 FIX: unreadCount is read from the Mongoose document before toObject()
//   converts the Map to a plain object, which would make .get() throw.
//
// ROUTE ORDER FIX: this is declared LAST among GET routes so that all
//   specific paths above are matched first by Express.
router.get("/:userId", fetchUser, async (req, res) => {
  try {
    // BUG 2 FIX: always use the authenticated user's id from the token
    const userId = req.user.id;

    const chats = await Chat.find({ members: userId })
      .populate("members", "name _id email username profileavatar lastActive")
      .populate("lastMessageSender", "name")
      .sort({ lastMessageTime: -1 });

    // BUG 3 FIX: read unreadCount from the Mongoose document (Map API)
    //   BEFORE calling toObject(), which converts Map → plain object.
    const chatsWithUnread = chats.map((chat) => {
      const unreadCount = chat.getUnreadCount(userId); // read from Map now
      const chatObj     = chat.toObject();              // convert after
      chatObj.unreadCount = unreadCount;                // overwrite with correct value
      return chatObj;
    });

    res.json(chatsWithUnread);
  } catch (err) {
    console.error("❌ Failed to load chats:", err.message);
    res.status(500).json({ message: "Could not load chats." });
  }
});

module.exports = router;