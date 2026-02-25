// backend/routes/message.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const Message = require("../models/Message");
const Chat = require("../models/Chat");
const fetchUser = require("../middleware/fetchuser");
const { createUploadMiddleware } = require("../middleware/upload");
const { generatePublicUrl } = require("../middleware/upload");
const generateThumbnail = require("../utils/generateThumbnail");

// 💡 Custom Multer instance for chat uploads
const upload = createUploadMiddleware("chatmedia");

// ✅ Send a message with media upload
router.post("/", fetchUser, upload.array("media", 5), async (req, res) => {
    try {
        const { text, chatId } = req.body;
        const sender = req.user?.id;

        if (!chatId) return res.status(400).json({ message: "Missing chatId" });

        // Text-only message
        if ((!req.files || req.files.length === 0) && text?.trim()) {
            const msg = await new Message({
                chatId,
                sender,
                text: text.trim(),
                seenBy: [sender],
            }).save();
            
            await msg.populate("sender", "name profileavatar _id");
            return res.status(201).json(msg);
        }

        const savedMessages = [];

        // Handle file uploads
        for (const file of req.files || []) {
            const mediaUrl = generatePublicUrl(file.path);
            const mediaType = file.mimetype.startsWith("video")
                ? "video"
                : file.mimetype.startsWith("image")
                    ? "image"
                    : file.mimetype.startsWith("audio")
                        ? "audio"
                        : "document";

            const message = new Message({
                chatId,
                sender,
                text: text || "",
                seenBy: [sender],
                mediaUrl,
                mediaType,
            });

            // Generate thumbnail for videos
            if (mediaType === "video") {
                const thumbnailPath = await generateThumbnail(file.path, file.mimetype);
                if (thumbnailPath) {
                    message.thumbnailUrl = generatePublicUrl(thumbnailPath);
                }
            }

            await message.save();
            await message.populate("sender", "name profileavatar _id");
            savedMessages.push(message);
        }

        if (savedMessages.length > 0) {
            return res.status(201).json(savedMessages[0]);
        }

        res.status(400).json({ message: "No valid files uploaded." });

    } catch (err) {
        console.error("❌ Upload error:", err.message);
        res.status(500).json({ message: "Failed to send message" });
    }
});

// ⭐ Send a reply message
router.post("/reply", fetchUser, async (req, res) => {
    try {
        const { chatId, text, replyToId } = req.body;
        const sender = req.user.id;

        if (!chatId || !text || !replyToId) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // Get the original message
        const originalMsg = await Message.findById(replyToId)
            .populate("sender", "name");

        if (!originalMsg) {
            return res.status(404).json({ message: "Original message not found" });
        }

        // Create reply message
        const message = new Message({
            chatId,
            sender,
            text: text.trim(),
            seenBy: [sender],
            replyTo: {
                messageId: originalMsg._id,
                text: originalMsg.text || `[${originalMsg.mediaType || 'Media'}]`,
                senderName: originalMsg.sender.name,
                mediaType: originalMsg.mediaType
            }
        });

        await message.save();
        await message.populate("sender", "name profileavatar _id");

        res.status(201).json(message);
    } catch (err) {
        console.error("❌ Reply failed:", err);
        res.status(500).json({ message: "Failed to send reply" });
    }
});

// ✅ Get messages for a chat
router.get("/:chatId", fetchUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50, before } = req.query;

        const query = {
            chatId: req.params.chatId,
            deletedBy: { $ne: userId }
        };

        // Pagination: get messages before a certain timestamp
        if (before) {
            query.createdAt = { $lt: new Date(before) };
        }

        const messages = await Message.find(query)
            .populate("sender", "name profileavatar _id")
            .populate("replyTo.messageId", "text sender mediaType")
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));

        // Reverse to show oldest first
        res.json(messages.reverse());
    } catch (err) {
        console.error("❌ Failed to fetch messages:", err);
        res.status(500).json({ message: "Could not retrieve messages" });
    }
});

// ✅ Mark messages as seen
router.post("/seen", fetchUser, async (req, res) => {
    try {
        const { messageIds } = req.body;
        const userId = req.user.id;

        await Message.updateMany(
            { 
                _id: { $in: messageIds }, 
                seenBy: { $ne: userId } 
            },
            { $addToSet: { seenBy: userId } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Mark as seen failed:", err);
        res.status(500).json({ message: "Failed to mark as seen" });
    }
});

// ⭐ Add or remove reaction to a message
router.put("/react/:messageId", fetchUser, async (req, res) => {
    try {
        const { emoji } = req.body; // emoji can be null to remove reaction
        const userId = req.user.id;

        const message = await Message.findById(req.params.messageId);
        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        await message.addReaction(userId, emoji);

        res.json({ 
            success: true, 
            reactions: message.reactions 
        });
    } catch (err) {
        console.error("❌ Reaction failed:", err);
        res.status(500).json({ message: "Failed to add reaction" });
    }
});

// ⭐ Edit a message (text only)
router.put("/edit/:messageId", fetchUser, async (req, res) => {
    try {
        const { text } = req.body;
        const userId = req.user.id;

        if (!text || !text.trim()) {
            return res.status(400).json({ message: "Text is required" });
        }

        const message = await Message.findById(req.params.messageId);

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        if (message.sender.toString() !== userId) {
            return res.status(403).json({ message: "Not authorized to edit this message" });
        }

        if (message.mediaUrl) {
            return res.status(400).json({ message: "Cannot edit messages with media" });
        }

        message.text = text.trim();
        message.isEdited = true;
        message.editedAt = new Date();

        await message.save();

        res.json({ success: true, message });
    } catch (err) {
        console.error("❌ Edit failed:", err);
        res.status(500).json({ message: "Failed to edit message" });
    }
});

// ✅ Delete for Me (soft delete per user)
router.put("/delete-for-me/:id", fetchUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const message = await Message.findById(req.params.id);

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        if (!message.deletedBy.includes(userId)) {
            message.deletedBy.push(userId);
            await message.save();
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Delete-for-me failed:", err);
        res.status(500).json({ message: "Failed to delete message" });
    }
});

// ✅ Delete for Everyone (hard delete + socket sync)
router.put("/delete-everyone/:id", fetchUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const message = await Message.findById(req.params.id);

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        if (message.sender.toString() !== userId) {
            return res.status(403).json({ 
                message: "Not allowed to delete this message for everyone" 
            });
        }

        // Remove media file if any
        if (message.mediaUrl) {
            const filePath = path.join(__dirname, "..", message.mediaUrl);
            fs.unlink(filePath, (err) => {
                if (!err) console.log("🧹 Deleted media file:", filePath);
            });
        }

        // Mark as deleted
        message.isDeleted = true;
        message.text = null;
        message.mediaUrl = null;
        message.mediaType = null;
        message.thumbnailUrl = null;

        await message.save();

        // Emit socket event to sync UI
        req.io?.to(message.chatId.toString()).emit("message-deleted", {
            messageId: message._id,
            type: "everyone"
        });

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Delete-for-everyone failed:", err);
        res.status(500).json({ message: "Failed to delete message" });
    }
});

// ❌ Permanent delete (only if sender)
router.delete("/:id", fetchUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const message = await Message.findById(req.params.id);

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        if (message.sender.toString() !== userId) {
            return res.status(403).json({ 
                message: "Unauthorized to delete this message" 
            });
        }

        // Delete media from filesystem if exists
        if (message.mediaUrl) {
            const filePath = path.join(__dirname, "..", message.mediaUrl);
            fs.unlink(filePath, (err) => {
                if (err && err.code !== "ENOENT") {
                    console.error("❌ Failed to delete media file:", err.message);
                } else {
                    console.log("🧹 Deleted media file:", filePath);
                }
            });
        }

        await Message.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Permanent delete failed:", err);
        res.status(500).json({ message: "Failed to delete message" });
    }
});

// ⭐ Forward message
router.post("/forward", fetchUser, async (req, res) => {
    try {
        const { messageId, chatIds } = req.body; // chatIds is array of chat IDs
        const sender = req.user.id;

        if (!messageId || !chatIds || !Array.isArray(chatIds)) {
            return res.status(400).json({ message: "Invalid request" });
        }

        const originalMsg = await Message.findById(messageId);
        if (!originalMsg) {
            return res.status(404).json({ message: "Message not found" });
        }

        const forwardedMessages = [];

        for (const chatId of chatIds) {
            const newMessage = new Message({
                chatId,
                sender,
                text: originalMsg.text,
                mediaUrl: originalMsg.mediaUrl,
                mediaType: originalMsg.mediaType,
                thumbnailUrl: originalMsg.thumbnailUrl,
                isForwarded: true,
                seenBy: [sender]
            });

            await newMessage.save();
            await newMessage.populate("sender", "name profileavatar _id");
            forwardedMessages.push(newMessage);
        }

        res.json({ 
            success: true, 
            forwarded: forwardedMessages.length 
        });
    } catch (err) {
        console.error("❌ Forward failed:", err);
        res.status(500).json({ message: "Failed to forward message" });
    }
});

// ⭐ Get message statistics
router.get("/stats/:chatId", fetchUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const chatId = req.params.chatId;

        const totalMessages = await Message.countDocuments({ 
            chatId,
            deletedBy: { $ne: userId }
        });

        const sentByMe = await Message.countDocuments({ 
            chatId,
            sender: userId,
            deletedBy: { $ne: userId }
        });

        const mediaMessages = await Message.countDocuments({ 
            chatId,
            mediaUrl: { $exists: true, $ne: null },
            deletedBy: { $ne: userId }
        });

        const unreadMessages = await Message.countDocuments({
            chatId,
            sender: { $ne: userId },
            seenBy: { $ne: userId },
            deletedBy: { $ne: userId }
        });

        res.json({
            totalMessages,
            sentByMe,
            receivedByMe: totalMessages - sentByMe,
            mediaMessages,
            unreadMessages
        });
    } catch (err) {
        console.error("❌ Stats failed:", err);
        res.status(500).json({ message: "Failed to get stats" });
    }
});

module.exports = router;