// backend/sockets/handlers/onConnection.js
const Message = require('../../models/Message');
const User = require('../../models/User');
const Profile = require('../../models/Profile');

const onlineUsers = new Map(); // userId -> socketId

// ✅ Check notification preferences before delivering
async function canNotify(userId, type) {
  try {
    const profile = await Profile.findOne({ user_id: userId });
    if (!profile) return true;

    const prefs = profile.settings?.notifications || {};

    if (type === 'push' && !prefs.push) return false;
    if (type === 'sms' && !prefs.sms) return false;
    if (prefs.mentionsOnly && !['mention', 'direct_message'].includes(type)) {
      return false;
    }
    return true;
  } catch (err) {
    console.error("❌ canNotify check failed:", err.message);
    return true; // fallback allow
  }
}

module.exports = function onConnection(io, socket) {
  const userId = socket.user?.id;

  console.log(`🔌 Connected: ${socket.id} for user ${userId}`);

  if (typeof userId === 'string') {
    socket.join(userId);
    onlineUsers.set(userId, socket.id);

    // Broadcast online event only if target allows discovery
    socket.broadcast.emit('user-online', { userId });

    const currentlyOnline = Array.from(onlineUsers.keys()).filter(id => id !== userId);
    io.emit('online-users', currentlyOnline);
  }

  console.log("🟢 Current online users:", Array.from(onlineUsers.keys()));

  // ✅ Handle typing indicator
  socket.on('typing', async ({ toUserId }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket && await canNotify(toUserId, 'direct_message')) {
      io.to(targetSocket).emit('user-typing', { fromUserId: userId });
    }
  });

  socket.on('stop_typing', async ({ toUserId }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket && await canNotify(toUserId, 'direct_message')) {
      io.to(targetSocket).emit('user-stop-typing', { fromUserId: userId });
    }
  });

  // ✅ Send message event
  socket.on('send_message', async ({ toUserId, message }) => {
    try {
      const targetSocket = onlineUsers.get(toUserId);

      if (targetSocket && await canNotify(toUserId, 'direct_message')) {
        io.to(targetSocket).emit('receive_message', {
          fromUserId: userId,
          message
        });
      }

      console.log(`📤 Message sent from ${userId} to ${toUserId}`);
    } catch (err) {
      console.error("❌ Error sending message:", err.message);
    }
  });

  // ✅ Seen acknowledgement
  socket.on('seen', async ({ messageIds }) => {
    try {
      await Message.updateMany(
        { _id: { $in: messageIds }, seenBy: { $ne: userId } },
        { $push: { seenBy: userId } }
      );
      console.log(`👁️ Seen updated for user ${userId} on ${messageIds.length} messages`);
    } catch (err) {
      console.error("❌ Seen update failed:", err.message);
    }
  });

  // ✅ Delete for everyone
  socket.on("delete-message-everyone", async ({ messageId, chatId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message || message.sender.toString() !== socket.user.id) return;

      message.isDeleted = true;
      message.text = null;
      message.mediaUrl = null;
      message.mediaType = null;
      await message.save();

      io.to(chatId).emit("message-deleted", {
        messageId,
        type: "everyone"
      });
    } catch (err) {
      console.error("❌ Delete for everyone failed:", err.message);
    }
  });

  // ✅ Clean up on disconnect
  socket.on('disconnect', async () => {
    console.log(`❌ User ${userId} disconnected`);
    onlineUsers.delete(userId);
    socket.broadcast.emit('user-offline', { userId });

    const currentlyOnline = Array.from(onlineUsers.keys());
    io.emit('online-users', currentlyOnline);

    // ✅ Update lastActive timestamp in DB
    try {
      await User.findByIdAndUpdate(userId, { lastActive: new Date() });
      console.log(`🕒 lastActive updated for user ${userId}`);
    } catch (err) {
      console.error(`❌ Failed to update lastActive for user ${userId}:`, err.message);
    }
  });
};
