// backend/utils/notifyUser.js
//
// Sends a notification to a user via three channels (in order):
//   1. Database    — always; source of truth for the notification bell
//   2. Socket.IO   — real-time, if user is connected (uses presence registry)
//   3. Web Push    — background, if user has a push subscription
//
// All three channels are independent — failure in one does not block the others.

const Notification = require("../models/Notification");

/**
 * @param {string|ObjectId} userId   Recipient user ObjectId
 * @param {string}          message  Human-readable notification text
 * @param {string}          type     One of the Notification schema enum values
 * @param {object}          [opts]
 * @param {string}          [opts.url]          Deep-link URL shown in the notification
 * @param {string|ObjectId} [opts.sender]       Sender user ObjectId (optional)
 * @param {object}          [opts.pushPayload]  Override for the web-push payload
 * @returns {Promise<import('../models/Notification').default|null>}
 */
const notifyUser = async (userId, message, type = "custom", opts = {}) => {
  const userIdStr = String(userId);
  let notification = null;

  // ── 1. Persist to DB ────────────────────────────────────────────────────────
  try {
    notification = await Notification.create({
      user:    userId,
      message,
      type,
      url:     opts.url    ?? undefined,
      sender:  opts.sender ?? undefined,
    });
  } catch (dbErr) {
    console.error(`[notifyUser] ❌ DB error for user ${userIdStr}:`, dbErr.message);
    return null; // Can't send a meaningful notification without a DB record
  }

  // ── 2. Real-time Socket.IO ──────────────────────────────────────────────────
  //   We use the presence-aware emitToUser helper from onConnection.js so that
  //   all of a user's open tabs receive the notification.
  try {
    const { getIO }       = require("../sockets/socketManager");
    const { emitToUser }  = require("../sockets/handlers/onConnection");

    const io = getIO();
    // emitToUser returns false if user is offline — that's fine, push covers it
    emitToUser(io, userIdStr, "notification", {
      _id:       notification._id,
      type,
      message,
      url:       opts.url ?? null,
      sender:    opts.sender ?? null,
      createdAt: notification.createdAt,
    });
  } catch (sockErr) {
    // Socket not initialised or user is offline — silently continue to push
    console.debug(`[notifyUser] Socket skipped for ${userIdStr}: ${sockErr.message}`);
  }

  // ── 3. Web Push ─────────────────────────────────────────────────────────────
  try {
    const { sendPushToUser } = require("./pushService");
    const pushPayload = opts.pushPayload ?? {
      title:   "SoShoLife",
      message,
      url:     opts.url ?? "/",
    };
    await sendPushToUser(userIdStr, pushPayload);
  } catch (pushErr) {
    // Push failure is non-critical (user may not have subscribed)
    console.debug(`[notifyUser] Push skipped for ${userIdStr}: ${pushErr.message}`);
  }

  console.log(`[notifyUser] ✅ ${type} → ${userIdStr}: ${message}`);
  return notification;
};

/**
 * Send the same notification to multiple users efficiently.
 * DB inserts are batched; sockets and push are fired in parallel per user.
 *
 * @param {string[]} userIds
 * @param {string}   message
 * @param {string}   type
 * @param {object}   [opts]
 */
const notifyMany = async (userIds, message, type = "custom", opts = {}) => {
  if (!userIds?.length) return [];

  // Deduplicate
  const unique = [...new Set(userIds.map(String))];

  // Batch DB insert
  let notifications = [];
  try {
    notifications = await Notification.insertMany(
      unique.map((uid) => ({
        user:    uid,
        message,
        type,
        url:     opts.url    ?? undefined,
        sender:  opts.sender ?? undefined,
      })),
      { ordered: false } // continue on partial failure
    );
  } catch (dbErr) {
    console.error(`[notifyMany] ❌ DB batch error:`, dbErr.message);
    return [];
  }

  // Socket + push in parallel (non-blocking)
  try {
    const { getIO }       = require("../sockets/socketManager");
    const { emitToUser }  = require("../sockets/handlers/onConnection");
    const { sendPushToUser } = require("./pushService");
    const io = getIO();

    await Promise.allSettled(
      notifications.map(async (n) => {
        const uid = n.user.toString();
        emitToUser(io, uid, "notification", {
          _id:       n._id,
          type,
          message,
          url:       opts.url ?? null,
          sender:    opts.sender ?? null,
          createdAt: n.createdAt,
        });
        if (opts.push !== false) {
          await sendPushToUser(uid, opts.pushPayload ?? {
            title: "SoShoLife", message, url: opts.url ?? "/"
          });
        }
      })
    );
  } catch (err) {
    console.warn("[notifyMany] Socket/push partial error:", err.message);
  }

  return notifications;
};

module.exports = notifyUser;
module.exports.notifyMany = notifyMany;