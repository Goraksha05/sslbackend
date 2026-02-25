// utils/notifyUser.js — Improved: socket + push + DB with full error isolation
const Notification = require('../models/Notification');

/**
 * Send a notification to a user via:
 *   1. Database (always)
 *   2. Real-time Socket.IO (if connected)
 *   3. Web Push (if subscribed)
 *
 * @param {String}  userId  - ObjectId of the recipient user
 * @param {String}  message - Human-readable message
 * @param {String}  type    - Notification type (see Notification schema enum)
 * @param {Object}  opts    - Optional extras: { url, sender, pushPayload }
 * @returns {Promise<Object|null>} The saved Notification document or null on failure
 */
const notifyUser = async (userId, message, type = 'custom', opts = {}) => {
  let notification = null;

  // ── 1. Persist to DB ────────────────────────────────────────────────────────
  try {
    notification = await Notification.create({
      user:    userId,
      message,
      type,
      url:     opts.url    || undefined,
      sender:  opts.sender || undefined,
    });
  } catch (dbErr) {
    console.error(`[notifyUser] DB error for ${userId}:`, dbErr.message);
    return null; // can't proceed without a saved notification
  }

  // ── 2. Real-time Socket.IO ──────────────────────────────────────────────────
  try {
    const { getIO } = require('../sockets/IOsocket');
    const io = getIO();
    io.to(String(userId)).emit('notification', {
      _id:       notification._id,
      type,
      message,
      url:       opts.url || null,
      createdAt: notification.createdAt,
    });
  } catch (sockErr) {
    // Socket not initialized or user not connected — silently continue
    console.warn(`[notifyUser] Socket emit skipped for ${userId}: ${sockErr.message}`);
  }

  // ── 3. Web Push ─────────────────────────────────────────────────────────────
  try {
    const { sendPushToUser } = require('./pushService');
    const pushPayload = opts.pushPayload || {
      title:   'SoShoLife',
      message,
      url:     opts.url || '/',
    };
    await sendPushToUser(String(userId), pushPayload);
  } catch (pushErr) {
    // Push failure is non-critical
    console.warn(`[notifyUser] Push skipped for ${userId}: ${pushErr.message}`);
  }

  console.log(`[notifyUser] ✅ Sent to ${userId} [${type}]: ${message}`);
  return notification;
};

module.exports = notifyUser;