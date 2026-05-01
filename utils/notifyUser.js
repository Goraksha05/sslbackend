// backend/utils/notifyUser.js

'use strict';

const Notification = require("../models/Notification");

// ── Brand constants ────────────────────────────────────────────────────────────
// Single source of truth for the logo paths used in every push notification.
// FRONTEND_BASE_URL is set in .env; falls back to the API host for dev.
const _BASE = (process.env.FRONTEND_BASE_URL || 'https://sosholife.com')
  .split(',')[0]   // take first origin if multiple are listed
  .trim()
  .replace(/\/$/, '');

const BRAND = Object.freeze({
  name:  'SoShoLife',
  icon:  `${_BASE}/logo.png`,   // small square icon shown beside the notification
  badge: `${_BASE}/logo.png`,   // monochrome badge on Android status bar
  image: `${_BASE}/logo.png`,   // large hero image (optional; browser-dependent)
});

/**
 * Build a complete, branded push payload.
 * Callers can pass a partial payload and the missing fields are filled from
 * the brand defaults — so every notification automatically has the logo.
 *
 * @param {string}  title
 * @param {string}  message
 * @param {string}  [url]
 * @param {object}  [overrides]  Any extra web-push fields (vibrate, tag, etc.)
 * @returns {object}
 */
function buildPushPayload(title, message, url = '/', overrides = {}) {
  return {
    title:   title   || BRAND.name,
    message: message || '',
    url,
    icon:    BRAND.icon,
    badge:   BRAND.badge,
    image:   BRAND.image,
    ...overrides,   // caller can still override individual fields
  };
}

// ── notifyUser ─────────────────────────────────────────────────────────────────

/**
 * @param {string|ObjectId} userId   Recipient user ObjectId
 * @param {string}          message  Human-readable notification text
 * @param {string}          type     One of the Notification schema enum values
 * @param {object}          [opts]
 * @param {string}          [opts.url]              Deep-link URL shown in the notification
 * @param {string|ObjectId} [opts.sender]           Sender user ObjectId (optional)
 * @param {object}          [opts.pushPayload]      Full push payload override
 * @param {string}          [opts.pushTitle]        Custom push title (default: "SoShoLife")
 * @param {object}          [opts.pushExtras]       Extra web-push fields merged into payload
 * @returns {Promise<Notification|null>}
 */
const notifyUser = async (userId, message, type = 'custom', opts = {}) => {
  const userIdStr = String(userId);
  let notification = null;

  // ── 1. Persist to DB ──────────────────────────────────────────────────────
  try {
    notification = await Notification.create({
      user:   userId,
      message,
      type,
      url:    opts.url    ?? undefined,
      sender: opts.sender ?? undefined,
    });
  } catch (dbErr) {
    console.error(`[notifyUser] ❌ DB error for user ${userIdStr}:`, dbErr.message);
    return null;
  }

  // ── 2. Real-time Socket.IO ─────────────────────────────────────────────────
  try {
    const { getIO }      = require('../sockets/socketManager');
    const { emitToUser } = require('../sockets/handlers/onConnection');
    const io = getIO();

    emitToUser(io, userIdStr, 'notification', {
      _id:       notification._id,
      type,
      message,
      url:       opts.url ?? null,
      sender:    opts.sender ?? null,
      icon:      BRAND.icon,        // include icon so in-app bell can show logo
      createdAt: notification.createdAt,
    });
  } catch (sockErr) {
    console.debug(`[notifyUser] Socket skipped for ${userIdStr}: ${sockErr.message}`);
  }

  // ── 3. Web Push (with branded logo) ───────────────────────────────────────
  try {
    const { sendPushToUser } = require('./pushService');

    // If the caller provided a full pushPayload, merge logo fields into it
    // (so existing callers that pass pushPayload still get the logo).
    // If no pushPayload was provided, build one from scratch with the logo.
    const pushPayload = opts.pushPayload
      ? {
          title:   "SoShoLife",
          icon:  BRAND.icon,
          badge: BRAND.badge,
          image: BRAND.image,
          ...opts.pushPayload,               // caller values win over defaults
        }
      : buildPushPayload(
          opts.pushTitle ?? BRAND.name,
          message,
          opts.url ?? '/',
          opts.pushExtras ?? {}
        );

    await sendPushToUser(userIdStr, pushPayload);
  } catch (pushErr) {
    console.debug(`[notifyUser] Push skipped for ${userIdStr}: ${pushErr.message}`);
  }

  console.log(`[notifyUser] ✅ ${type} → ${userIdStr}: ${message}`);
  return notification;
};

// ── notifyMany ─────────────────────────────────────────────────────────────────

/**
 * Send the same notification to multiple users efficiently.
 * DB inserts are batched; sockets and push are fired in parallel per user.
 *
 * @param {string[]} userIds
 * @param {string}   message
 * @param {string}   type
 * @param {object}   [opts]   Same opts as notifyUser
 * @returns {Promise<Notification[]>}
 */
const notifyMany = async (userIds, message, type = 'custom', opts = {}) => {
  if (!userIds?.length) return [];

  const unique = [...new Set(userIds.map(String))];

  // Batch DB insert
  let notifications = [];
  try {
    notifications = await Notification.insertMany(
      unique.map((uid) => ({
        user:   uid,
        message,
        type,
        url:    opts.url    ?? undefined,
        sender: opts.sender ?? undefined,
      })),
      { ordered: false }
    );
  } catch (dbErr) {
    console.error('[notifyMany] ❌ DB batch error:', dbErr.message);
    return [];
  }

  // Build the branded push payload once (shared across all recipients)
  const sharedPush = opts.pushPayload
    ? { icon: BRAND.icon, badge: BRAND.badge, image: BRAND.image, ...opts.pushPayload }
    : buildPushPayload(
        opts.pushTitle ?? BRAND.name,
        message,
        opts.url ?? '/',
        opts.pushExtras ?? {}
      );

  // Socket + push in parallel
  try {
    const { getIO }      = require('../sockets/socketManager');
    const { emitToUser } = require('../sockets/handlers/onConnection');
    const { sendPushToUser } = require('./pushService');
    const io = getIO();

    await Promise.allSettled(
      notifications.map(async (n) => {
        const uid = n.user.toString();

        emitToUser(io, uid, 'notification', {
          _id:       n._id,
          type,
          message,
          url:       opts.url ?? null,
          sender:    opts.sender ?? null,
          icon:      BRAND.icon,
          createdAt: n.createdAt,
        });

        if (opts.push !== false) {
          await sendPushToUser(uid, sharedPush);
        }
      })
    );
  } catch (err) {
    console.warn('[notifyMany] Socket/push partial error:', err.message);
  }

  return notifications;
};

// ── Exports ────────────────────────────────────────────────────────────────────
module.exports = notifyUser;
module.exports.notifyMany      = notifyMany;
module.exports.buildPushPayload = buildPushPayload;
module.exports.BRAND            = BRAND;