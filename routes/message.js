// backend/routes/message.js
//
// FIX: generatePublicUrl(req, subDir, userId, filename) requires four arguments.
// The original called generatePublicUrl(file.path) — a single argument — which
// returned undefined for every media URL, storing null in the DB and breaking
// media display for all chat users. The same mistake appeared for thumbnail URLs.
// Fixed by extracting the filename from file.path and passing all four args.

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const Message  = require('../models/Message');
const Chat     = require('../models/Chat');
const fetchUser = require('../middleware/fetchuser');
const { createUploadMiddleware, generatePublicUrl } = require('../middleware/upload');
const generateThumbnail = require('../utils/generateThumbnail');

const upload = createUploadMiddleware('chatmedia');

// ── POST / — Send a message (text or with media) ──────────────────────────────
router.post('/', fetchUser, upload.array('media', 5), async (req, res) => {
  try {
    const { text, chatId } = req.body;
    const sender = req.user?.id;

    if (!chatId) return res.status(400).json({ message: 'Missing chatId' });

    // Text-only message
    if ((!req.files || req.files.length === 0) && text?.trim()) {
      const msg = await new Message({
        chatId,
        sender,
        text: text.trim(),
        seenBy: [sender],
      }).save();
      await msg.populate('sender', 'name profileavatar _id');
      return res.status(201).json(msg);
    }

    const savedMessages = [];

    for (const file of req.files || []) {
      // FIX: generatePublicUrl needs (req, subDir, userId, filename).
      // file.path is the full absolute disk path; extract just the filename.
      const filename = path.basename(file.path);
      const mediaUrl = generatePublicUrl(req, 'chatmedia', sender, filename);

      const mediaType =
        file.mimetype.startsWith('video') ? 'video' :
        file.mimetype.startsWith('image') ? 'image' :
        file.mimetype.startsWith('audio') ? 'audio' :
        'document';

      const message = new Message({
        chatId,
        sender,
        text: text || '',
        seenBy: [sender],
        mediaUrl,
        mediaType,
      });

      // Generate thumbnail for videos
      if (mediaType === 'video') {
        try {
          const thumbnailPath = await generateThumbnail(file.path, file.mimetype);
          if (thumbnailPath) {
            // FIX: same four-argument fix for thumbnail URL
            const thumbFilename = path.basename(thumbnailPath);
            message.thumbnailUrl = generatePublicUrl(req, 'chatmedia', sender, thumbFilename);
          }
        } catch (thumbErr) {
          console.warn('[message] Thumbnail generation failed (non-fatal):', thumbErr.message);
        }
      }

      await message.save();
      await message.populate('sender', 'name profileavatar _id');
      savedMessages.push(message);
    }

    if (savedMessages.length > 0) {
      return res.status(201).json(savedMessages[0]);
    }

    return res.status(400).json({ message: 'No valid files uploaded.' });
  } catch (err) {
    console.error('❌ Upload error:', err.message);
    return res.status(500).json({ message: 'Failed to send message' });
  }
});

// ── POST /reply — Send a reply message ───────────────────────────────────────
router.post('/reply', fetchUser, async (req, res) => {
  try {
    const { chatId, text, replyToId } = req.body;
    const sender = req.user.id;

    if (!chatId || !text || !replyToId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const originalMsg = await Message.findById(replyToId).populate('sender', 'name');
    if (!originalMsg) {
      return res.status(404).json({ message: 'Original message not found' });
    }

    const message = new Message({
      chatId,
      sender,
      text: text.trim(),
      seenBy: [sender],
      replyTo: {
        messageId:  originalMsg._id,
        text:       originalMsg.text || `[${originalMsg.mediaType || 'Media'}]`,
        senderName: originalMsg.sender.name,
        mediaType:  originalMsg.mediaType,
      },
    });

    await message.save();
    await message.populate('sender', 'name profileavatar _id');
    return res.status(201).json(message);
  } catch (err) {
    console.error('❌ Reply failed:', err);
    return res.status(500).json({ message: 'Failed to send reply' });
  }
});

// ── GET /:chatId — Get messages for a chat ────────────────────────────────────
router.get('/:chatId', fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, before } = req.query;

    const query = {
      chatId:    req.params.chatId,
      deletedBy: { $ne: userId },
    };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .populate('sender', 'name profileavatar _id')
      .populate('replyTo.messageId', 'text sender mediaType')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    return res.json(messages.reverse());
  } catch (err) {
    console.error('❌ Failed to fetch messages:', err);
    return res.status(500).json({ message: 'Could not retrieve messages' });
  }
});

// ── POST /seen — Mark messages as seen ───────────────────────────────────────
router.post('/seen', fetchUser, async (req, res) => {
  try {
    const { messageIds } = req.body;
    const userId = req.user.id;

    await Message.updateMany(
      { _id: { $in: messageIds }, seenBy: { $ne: userId } },
      { $addToSet: { seenBy: userId } }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Mark as seen failed:', err);
    return res.status(500).json({ message: 'Failed to mark as seen' });
  }
});

// ── PUT /react/:messageId — Add or remove a reaction ─────────────────────────
router.put('/react/:messageId', fetchUser, async (req, res) => {
  try {
    const { emoji } = req.body;
    const userId    = req.user.id;

    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ message: 'Message not found' });

    await message.addReaction(userId, emoji);
    return res.json({ success: true, reactions: message.reactions });
  } catch (err) {
    console.error('❌ Reaction failed:', err);
    return res.status(500).json({ message: 'Failed to add reaction' });
  }
});

// ── PUT /edit/:messageId — Edit a text message ────────────────────────────────
router.put('/edit/:messageId', fetchUser, async (req, res) => {
  try {
    const { text } = req.body;
    const userId   = req.user.id;

    if (!text?.trim()) return res.status(400).json({ message: 'Text is required' });

    const message = await Message.findById(req.params.messageId);
    if (!message)                              return res.status(404).json({ message: 'Message not found' });
    if (message.sender.toString() !== userId)  return res.status(403).json({ message: 'Not authorized to edit this message' });
    if (message.mediaUrl)                      return res.status(400).json({ message: 'Cannot edit messages with media' });

    message.text     = text.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    return res.json({ success: true, message });
  } catch (err) {
    console.error('❌ Edit failed:', err);
    return res.status(500).json({ message: 'Failed to edit message' });
  }
});

// ── PUT /delete-for-me/:id — Soft delete per user ────────────────────────────
router.put('/delete-for-me/:id', fetchUser, async (req, res) => {
  try {
    const userId  = req.user.id;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ message: 'Message not found' });

    if (!message.deletedBy.includes(userId)) {
      message.deletedBy.push(userId);
      await message.save();
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete-for-me failed:', err);
    return res.status(500).json({ message: 'Failed to delete message' });
  }
});

// ── PUT /delete-everyone/:id — Hard delete visible to all ────────────────────
router.put('/delete-everyone/:id', fetchUser, async (req, res) => {
  try {
    const userId  = req.user.id;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ message: 'Message not found' });

    if (message.sender.toString() !== userId) {
      return res.status(403).json({ message: 'Not allowed to delete this message for everyone' });
    }

    // Remove media file from disk if it exists (best-effort)
    if (message.mediaUrl) {
      const filePath = path.join(__dirname, '..', message.mediaUrl);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') console.warn('Could not delete media file:', err.message);
      });
    }

    message.isDeleted  = true;
    message.text       = null;
    message.mediaUrl   = null;
    message.mediaType  = null;
    message.thumbnailUrl = null;
    await message.save();

    req.io?.to(message.chatId.toString()).emit('message-deleted', {
      messageId: message._id,
      type: 'everyone',
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete-for-everyone failed:', err);
    return res.status(500).json({ message: 'Failed to delete message' });
  }
});

// ── DELETE /:id — Permanent delete (sender only) ─────────────────────────────
router.delete('/:id', fetchUser, async (req, res) => {
  try {
    const userId  = req.user.id;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ message: 'Message not found' });

    if (message.sender.toString() !== userId) {
      return res.status(403).json({ message: 'Unauthorized to delete this message' });
    }

    if (message.mediaUrl) {
      const filePath = path.join(__dirname, '..', message.mediaUrl);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') console.error('❌ Failed to delete media file:', err.message);
      });
    }

    await Message.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Permanent delete failed:', err);
    return res.status(500).json({ message: 'Failed to delete message' });
  }
});

// ── POST /forward — Forward message to multiple chats ────────────────────────
router.post('/forward', fetchUser, async (req, res) => {
  try {
    const { messageId, chatIds } = req.body;
    const sender = req.user.id;

    if (!messageId || !Array.isArray(chatIds)) {
      return res.status(400).json({ message: 'Invalid request' });
    }

    const originalMsg = await Message.findById(messageId);
    if (!originalMsg) return res.status(404).json({ message: 'Message not found' });

    const forwardedMessages = [];
    for (const chatId of chatIds) {
      const newMessage = new Message({
        chatId,
        sender,
        text:         originalMsg.text,
        mediaUrl:     originalMsg.mediaUrl,
        mediaType:    originalMsg.mediaType,
        thumbnailUrl: originalMsg.thumbnailUrl,
        isForwarded:  true,
        seenBy:       [sender],
      });
      await newMessage.save();
      await newMessage.populate('sender', 'name profileavatar _id');
      forwardedMessages.push(newMessage);
    }

    return res.json({ success: true, forwarded: forwardedMessages.length });
  } catch (err) {
    console.error('❌ Forward failed:', err);
    return res.status(500).json({ message: 'Failed to forward message' });
  }
});

// ── GET /stats/:chatId — Message statistics ───────────────────────────────────
router.get('/stats/:chatId', fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const chatId = req.params.chatId;

    const [totalMessages, sentByMe, mediaMessages, unreadMessages] = await Promise.all([
      Message.countDocuments({ chatId, deletedBy: { $ne: userId } }),
      Message.countDocuments({ chatId, sender: userId, deletedBy: { $ne: userId } }),
      Message.countDocuments({ chatId, mediaUrl: { $exists: true, $ne: null }, deletedBy: { $ne: userId } }),
      Message.countDocuments({ chatId, sender: { $ne: userId }, seenBy: { $ne: userId }, deletedBy: { $ne: userId } }),
    ]);

    return res.json({
      totalMessages,
      sentByMe,
      receivedByMe: totalMessages - sentByMe,
      mediaMessages,
      unreadMessages,
    });
  } catch (err) {
    console.error('❌ Stats failed:', err);
    return res.status(500).json({ message: 'Failed to get stats' });
  }
});

module.exports = router;