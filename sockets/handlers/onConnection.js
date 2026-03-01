// backend/socket/handlers/onConnection.js
//
// Responsibilities:
//   • Maintain an in-memory presence registry (userId → Set<socketId>)
//   • Handle all per-socket events for messaging, typing, reactions, calls
//   • Export presence helpers used by notifyUser and other server utilities
//
// NOT responsible for:
//   • match-suggestion broadcasts   (IOsocket.js)
//   • socket auth middleware         (verifySocketUser.js)
//   • socket server creation         (IOsocket.js)

const User    = require("../../models/User");
const Chat    = require("../../models/Chat");
const Message = require("../../models/Message");

// ─── Presence registry ────────────────────────────────────────────────────────
//   userId  → Set<socketId>   (multi-tab safe)
//   socketId → userId          (reverse lookup for disconnect)
const userSockets  = new Map(); // userId  → Set<socketId>
const socketToUser = new Map(); // socketId → userId

// ─── Presence helpers (exported) ──────────────────────────────────────────────
function addPresence(userId, socketId) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
  socketToUser.set(socketId, userId);
}

function removePresence(socketId) {
  const userId = socketToUser.get(socketId);
  if (!userId) return null;
  socketToUser.delete(socketId);
  const sockets = userSockets.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) userSockets.delete(userId);
  }
  return userId;
}

/** True if the user has at least one connected socket (multi-tab aware). */
function isUserOnline(userId) {
  const s = userSockets.get(String(userId));
  return !!(s && s.size > 0);
}

/** Returns the first socket ID for a user, or undefined. */
function getUserSocket(userId) {
  const s = userSockets.get(String(userId));
  return s ? s.values().next().value : undefined;
}

/** Emit to ALL sockets belonging to a user (covers multiple tabs). */
function emitToUser(io, userId, event, payload) {
  const sockets = userSockets.get(String(userId));
  if (!sockets) return false;
  sockets.forEach(sid => io.to(sid).emit(event, payload));
  return true;
}

/** Array of currently online userIds. */
function getOnlineUserIds() {
  return Array.from(userSockets.keys());
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────
function broadcastPresence(io, userId, isOnline) {
  io.emit("user-status-changed", {
    userId,
    isOnline,
    lastActive: new Date(),
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────
/**
 * Called by IOsocket.js as: onConnection(io, socket)
 * The socket has already been auth-verified and joined its personal room.
 */
function onConnection(io, socket) {
  // userId is guaranteed by IOsocket.js auth guard
  const userId = socket.user._id.toString();

  // ── Register presence ────────────────────────────────────────────────────
  addPresence(userId, socket.id);
  broadcastPresence(io, userId, true);

  // Immediately send the online-users list to this new socket only
  socket.emit("online-users", getOnlineUserIds());

  // Update lastActive in DB (fire-and-forget)
  User.findByIdAndUpdate(userId, { lastActive: new Date() }).catch(() => {});

  // ==========================================
  // ROOM MANAGEMENT
  // ==========================================

  socket.on("join-room", (roomId) => {
    if (roomId && typeof roomId === "string") {
      socket.join(roomId);
    }
  });

  socket.on("leave-room", (roomId) => {
    if (roomId && typeof roomId === "string") {
      socket.leave(roomId);
    }
  });

  // ==========================================
  // MESSAGING
  // ==========================================

  /**
   * send_message:
   *   Delivers a message to a specific user. If offline, queues it.
   *   Avoids redundant DB writes — delivered-to is tracked only when the
   *   recipient is actually online and the message has a DB id.
   */
  socket.on("send_message", async ({ toUserId, message }) => {
    try {
      if (!toUserId || !message) return;

      const delivered = emitToUser(io, toUserId, "receive_message", {
        fromUserId: userId,
        message,
      });

      if (delivered && message._id) {
        // Mark delivered only for online recipients to avoid writes for offline
        Message.findByIdAndUpdate(message._id, {
          $addToSet: {
            deliveredTo: { userId: toUserId, deliveredAt: new Date() },
          },
        }).catch(() => {});

        socket.emit("message-delivered", {
          messageId: message._id,
          deliveredTo: toUserId,
        });
      } else {
        socket.emit("message-queued", {
          messageId: message._id,
          recipientId: toUserId,
        });
      }
    } catch (err) {
      console.error("❌ send_message error:", err.message);
      socket.emit("message-error", { error: "Failed to send message" });
    }
  });

  /**
   * broadcast_message:
   *   Sends a message to an entire chat room (group or 1-to-1 room).
   *   Chat's lastMessage is updated by the Message pre-save hook; we only
   *   update it here if the hook is bypassed (e.g. forwarded/system messages).
   */
  socket.on("broadcast_message", async ({ chatId, message }) => {
    try {
      if (!chatId || !message) return;
      io.to(chatId).emit("receive_message", { fromUserId: userId, message });
    } catch (err) {
      console.error("❌ broadcast_message error:", err.message);
    }
  });

  // ==========================================
  // TYPING INDICATORS
  // ==========================================

  socket.on("typing", ({ toUserId, chatId }) => {
    try {
      // Direct user notification (1-to-1)
      emitToUser(io, toUserId, "user-typing", { fromUserId: userId, chatId });
      // Room-based (group chats)
      if (chatId) socket.to(chatId).emit("user-typing", { fromUserId: userId, chatId });
    } catch (err) {
      console.error("❌ typing error:", err.message);
    }
  });

  socket.on("stop-typing", ({ toUserId, chatId }) => {
    try {
      emitToUser(io, toUserId, "user-stop-typing", { fromUserId: userId, chatId });
      if (chatId) socket.to(chatId).emit("user-stop-typing", { fromUserId: userId, chatId });
    } catch (err) {
      console.error("❌ stop-typing error:", err.message);
    }
  });

  // ==========================================
  // MESSAGE STATUS & ACTIONS
  // ==========================================

  socket.on("message-seen", async ({ messageId, chatId }) => {
    try {
      const message = await Message.findByIdAndUpdate(
        messageId,
        { $addToSet: { seenBy: userId } },
        { new: true }
      );
      if (message) {
        // Notify sender on all their devices
        emitToUser(io, message.sender.toString(), "message-read", {
          messageId,
          readBy: userId,
          chatId,
        });
      }
    } catch (err) {
      console.error("❌ message-seen error:", err.message);
    }
  });

  socket.on("message-deleted", ({ chatId, messageId, type }) => {
    try {
      io.to(chatId).emit("message-deleted", { messageId, type, deletedBy: userId });
    } catch (err) {
      console.error("❌ message-deleted error:", err.message);
    }
  });

  socket.on("message-edited", ({ chatId, messageId, newText }) => {
    try {
      io.to(chatId).emit("message-edited", {
        messageId,
        newText,
        editedAt: new Date(),
        editedBy: userId,
      });
    } catch (err) {
      console.error("❌ message-edited error:", err.message);
    }
  });

  socket.on("reaction-added", ({ chatId, messageId, emoji }) => {
    try {
      io.to(chatId).emit("reaction-added", { messageId, userId, emoji });
    } catch (err) {
      console.error("❌ reaction-added error:", err.message);
    }
  });

  // ==========================================
  // NOTIFICATIONS
  // ==========================================

  /**
   * notify:
   *   Server-to-client only in practice, but some clients emit this to
   *   trigger peer notifications. Route through notifyUser in production.
   */
  socket.on("notify", ({ recipientId, message, type, data }) => {
    try {
      if (!recipientId) return;
      emitToUser(io, recipientId, "notification", {
        message,
        type,
        data,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("❌ notify error:", err.message);
    }
  });

  socket.on("friend-request", ({ toUserId, fromUser }) => {
    try {
      emitToUser(io, toUserId, "notification", {
        type: "friend_request",
        message: `${fromUser?.name} sent you a friend request`,
        data: { fromUser },
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("❌ friend-request error:", err.message);
    }
  });

  // ==========================================
  // CALL EVENTS (WebRTC signalling)
  // ==========================================

  socket.on("call-user", ({ toUserId, offer, callType }) => {
    try {
      emitToUser(io, toUserId, "incoming-call", { fromUserId: userId, offer, callType });
    } catch (err) {
      console.error("❌ call-user error:", err.message);
    }
  });

  socket.on("answer-call", ({ toUserId, answer }) => {
    try {
      emitToUser(io, toUserId, "call-answered", { answer, fromUserId: userId });
    } catch (err) {
      console.error("❌ answer-call error:", err.message);
    }
  });

  socket.on("ice-candidate", ({ toUserId, candidate }) => {
    try {
      emitToUser(io, toUserId, "ice-candidate", { candidate, fromUserId: userId });
    } catch (err) {
      console.error("❌ ice-candidate error:", err.message);
    }
  });

  socket.on("reject-call", ({ toUserId }) => {
    try {
      emitToUser(io, toUserId, "call-rejected", { fromUserId: userId });
    } catch (err) {
      console.error("❌ reject-call error:", err.message);
    }
  });

  socket.on("end-call", ({ toUserId }) => {
    try {
      emitToUser(io, toUserId, "call-ended", { fromUserId: userId });
    } catch (err) {
      console.error("❌ end-call error:", err.message);
    }
  });

  // ==========================================
  // DISCONNECT
  // ==========================================

  socket.on("disconnect", async (reason) => {
    try {
      const removedUserId = removePresence(socket.id);
      if (!removedUserId) return;

      // Only broadcast offline if user has no other connected sockets (other tabs)
      if (!isUserOnline(removedUserId)) {
        await User.findByIdAndUpdate(removedUserId, { lastActive: new Date() });
        broadcastPresence(io, removedUserId, false);
        io.emit("online-users", getOnlineUserIds());
      }

      console.log(
        `🔌 Socket ${socket.id} (user: ${removedUserId}) disconnected [${reason}]. ` +
        `Still online: ${isUserOnline(removedUserId)}`
      );
    } catch (err) {
      console.error("❌ disconnect error:", err.message);
    }
  });

  socket.on("error", (error) => {
    console.error(`❌ Socket error (user: ${userId}):`, error);
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = onConnection;
module.exports.isUserOnline   = isUserOnline;
module.exports.getUserSocket  = getUserSocket;
module.exports.emitToUser     = emitToUser;
module.exports.getOnlineUserIds = getOnlineUserIds;