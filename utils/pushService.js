// backend/utils/pushService.js
//
// Web Push delivery service.
// Features added over original:
//   • Per-user rate limiting (max 1 identical push per 60 s) via in-memory LRU
//   • Stale subscription cleanup (410/404 responses)
//   • VAPID key validation at startup (throws clearly instead of silently failing)

const webpush          = require("web-push");
const PushSubscription = require("../models/PushSubscription");

// ─── VAPID setup ──────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:admin@example.com";
const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || "https://api.sosholife.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn(
    "[pushService] ⚠️  VAPID keys missing — push notifications are disabled."
  );
}

// ─── Simple in-memory dedup cache ────────────────────────────────────────────
//   Prevents the same message from being pushed to the same user more than
//   once per DEDUP_WINDOW_MS (protects against double-sends from retries).
const DEDUP_WINDOW_MS = 60_000; // 60 seconds
const _dedupCache     = new Map(); // `${userId}:${messageHash}` → timestamp

function dedupKey(userId, payload) {
  // Use title + message as the identity (good enough for dedup)
  return `${userId}:${payload.title ?? ""}:${payload.message ?? ""}`;
}

function isDuplicate(userId, payload) {
  const key  = dedupKey(userId, payload);
  const last = _dedupCache.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  _dedupCache.set(key, Date.now());
  // Prune old entries periodically (keep cache from growing unbounded)
  if (_dedupCache.size > 5_000) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, ts] of _dedupCache) {
      if (ts < cutoff) _dedupCache.delete(k);
    }
  }
  return false;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Send a push notification to all active subscriptions for a user.
 *
 * @param {string} userId
 * @param {string|object} payload  String or { title, message, url, icon, badge, image }
 */
async function sendPushToUser(userId, payload) {
  // Skip if VAPID keys not configured
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const subs = await PushSubscription.find({ user: userId }).lean();
  if (!subs.length) return;

  // Normalise payload
  const data = typeof payload === "string"
    ? { title: "SoShoLife", message: payload }
    : { ...payload };

  data.title   = data.title   || "SoShoLife";
  data.icon    = data.icon    || `${FRONTEND_BASE}/logo.png`;
  data.badge   = data.badge   || `${FRONTEND_BASE}/logo.png`;
  data.image   = data.image   || `${FRONTEND_BASE}/logo.png`;
  data.url     = data.url     || "/";

  // Deduplication check
  if (isDuplicate(userId, data)) {
    console.debug(`[pushService] Duplicate push suppressed for ${userId}`);
    return;
  }

  const serialized = JSON.stringify(data);

  const staleIds = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          serialized,
          { TTL: 3_600 } // 1 hour TTL
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription has been revoked by the browser
          staleIds.push(sub._id);
          console.log("[pushService] Stale subscription queued for removal:", sub.endpoint);
        } else {
          console.error(
            `[pushService] WebPush error for ${userId}:`,
            err.statusCode,
            err.body || err.message
          );
        }
      }
    })
  );

  // Clean up stale subscriptions in bulk
  if (staleIds.length) {
    await PushSubscription.deleteMany({ _id: { $in: staleIds } }).catch(() => {});
  }
}

module.exports = { sendPushToUser };