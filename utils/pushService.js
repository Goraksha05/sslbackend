// backend/utils/pushService.js
//
// Web Push delivery service.
//
// Features:
//   • Brand identity enforced — icon and badge are ALWAYS stamped with the
//     SoShoLife logo. Callers cannot accidentally send an unbranded notification.
//   • Per-user rate limiting (max 1 identical push per 60 s) via in-memory LRU
//   • Stale subscription cleanup (410/404 responses)
//   • VAPID key validation at startup (warns clearly instead of silently failing)
//
// Logo resolution:
//   The logo must be served from the FRONTEND origin (not the API server) so
//   that browsers can fetch it when displaying the notification — even when
//   the app is closed. The correct env var is FRONTEND_URL (the React/Next
//   app's public URL, e.g. https://sosholife.com).
//
//   Resolution order (first match wins):
//     1. PUSH_ICON_URL   — explicit absolute URL override (CDN, S3, etc.)
//     2. FRONTEND_URL    — frontend origin + /logo.png
//     3. FRONTEND_BASE_URL — legacy alias for the above
//     4. Hard fallback   — https://sosholife.com/logo.png
//
//   The logo lives at the web-root of the frontend (public/logo.png), which
//   Create React App serves as /logo.png. That is the correct path to use here.
//   Do NOT use the API server URL (CLOUDINARY / express static) because push
//   notifications are displayed by the OS before any auth headers can be set.

"use strict";

const webpush          = require("web-push");
const PushSubscription = require("../models/PushSubscription");

// ─── VAPID setup ──────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:admin@sosholife.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn(
    "[pushService] ⚠️  VAPID keys missing — push notifications are disabled."
  );
}

// ─── Brand asset URLs ─────────────────────────────────────────────────────────
//
// PUSH_ICON_URL  — optional absolute URL to a square notification icon
//                  (192×192 px minimum; PNG with transparency recommended).
//                  Set this in .env if you serve assets from a CDN.
//
// PUSH_BADGE_URL — optional absolute URL to a monochrome badge icon
//                  (96×96 px; must be solid white on transparent background
//                  so Android can tint it correctly in the status bar).
//                  If omitted, falls back to the same logo as the icon.
//
// Why /logo.png and not /src/Assets/logo.png?
//   public/logo.png is served at the web root by both CRA dev-server and any
//   production static host. The src/Assets path is only accessible during the
//   build process (webpack) and is NOT reachable via HTTP at runtime.

const _frontendOrigin = (() => {
  // Strip any trailing slash so we can safely append /logo.png
  const raw =
    process.env.PUSH_ICON_URL        ? null  // will be used directly, skip
    : (process.env.FRONTEND_BASE_URL ||
       "https://sosholife.com");
  return raw ? raw.replace(/\/$/, "") : null;
})();

const BRAND_ICON  = process.env.PUSH_ICON_URL  || `${_frontendOrigin}/logo.png`;
const BRAND_BADGE = process.env.PUSH_BADGE_URL || `${_frontendOrigin}/logo.png`;

// Log resolved URLs once at startup so ops can verify them in server logs
console.log(`[pushService] icon  → ${BRAND_ICON}`);
console.log(`[pushService] badge → ${BRAND_BADGE}`);

// ─── Simple in-memory dedup cache ────────────────────────────────────────────
//   Prevents the same message from being pushed to the same user more than
//   once per DEDUP_WINDOW_MS (protects against double-sends from retries).
const DEDUP_WINDOW_MS = 60_000; // 60 seconds
const _dedupCache     = new Map(); // `${userId}:${title}:${message}` → timestamp

function dedupKey(userId, payload) {
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

// ─── Payload normaliser ───────────────────────────────────────────────────────
/**
 * Merge caller-supplied payload with brand defaults.
 *
 * Rules:
 *  - `title`   defaults to "SoShoLife" if blank.
 *  - `icon`    is ALWAYS overridden with BRAND_ICON.
 *    Callers must NOT supply a custom icon — the brand logo must appear on
 *    every notification without exception.
 *  - `badge`   is ALWAYS overridden with BRAND_BADGE for the same reason.
 *  - `image`   (large hero image shown on Android) is left as-is when the
 *    caller provides one (e.g. a post thumbnail), otherwise omitted.
 *    We deliberately do NOT default image to the logo because a square logo
 *    looks wrong as a 2:1 hero image.
 *  - `url`     defaults to "/" (app home).
 *
 * @param {string|object} payload
 * @returns {object}
 */
function normalisePushPayload(payload) {
  const base = typeof payload === "string"
    ? { title: "SoShoLife", message: payload }
    : { ...payload };

  return {
    // Content
    title:   base.title   || "SoShoLife",
    message: base.message || "",
    url:     base.url     || "/",

    // Brand identity — always enforced, never overridable by callers
    icon:  BRAND_ICON,
    badge: BRAND_BADGE,

    // Hero image — only include if the caller explicitly provided one
    ...(base.image ? { image: base.image } : {}),

    // Pass through any other caller-supplied fields (tag, renotify, actions, etc.)
    ...Object.fromEntries(
      Object.entries(base).filter(
        ([k]) => !["title", "message", "url", "icon", "badge", "image"].includes(k)
      )
    ),
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Send a branded push notification to all active subscriptions for a user.
 *
 * The icon and badge are always set to the SoShoLife logo regardless of what
 * the caller passes — this guarantees every notification is on-brand.
 *
 * @param {string}        userId
 * @param {string|object} payload
 *   String  → used as the notification body; title defaults to "SoShoLife".
 *   Object  → { title?, message, url?, image?, tag?, actions?, ...rest }
 *             `icon` and `badge` in the object are silently replaced.
 * @returns {Promise<void>}
 */
async function sendPushToUser(userId, payload) {
  // Skip if VAPID keys not configured
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const subs = await PushSubscription.find({ user: userId }).lean();
  if (!subs.length) return;

  const data = normalisePushPayload(payload);

  // Deduplication — suppress identical messages within the dedup window
  if (isDuplicate(userId, data)) {
    console.debug(`[pushService] Duplicate push suppressed for ${userId}`);
    return;
  }

  const serialized = JSON.stringify(data);
  const staleIds   = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          serialized,
          { TTL: 3_600 } // cache for up to 1 hour if device is offline
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Browser has revoked this subscription — queue for removal
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

  // Remove stale subscriptions in bulk to keep the collection clean
  if (staleIds.length) {
    await PushSubscription.deleteMany({ _id: { $in: staleIds } }).catch(() => {});
  }
}

module.exports = { sendPushToUser, BRAND_ICON, BRAND_BADGE };