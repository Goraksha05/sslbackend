/**
 * middleware/fetchuser.js — Production-Ready JWT Auth Middleware
 *
 * Improvements over previous version:
 *
 *  ✅ FIX: require("dotenv").config() removed — dotenv must be called exactly
 *     once at the app entry point (index.js). Calling it again here with
 *     { override: true } silently clobbers environment variables that the
 *     main process may have already resolved from its own .env path, causing
 *     hard-to-debug config drift in multi-env deployments.
 *
 *  ✅ FIX: In-memory user cache with TTL (default 30 s).
 *     Every authenticated request previously hit MongoDB unconditionally.
 *     Under moderate load (e.g. 100 concurrent users each polling every
 *     5 seconds) that is 100–200 redundant DB round-trips per second just
 *     for auth. The cache stores the resolved req.user shape (no Mongoose
 *     document, no sensitive fields) keyed by userId. On cache hit the DB
 *     query is skipped entirely. The cache is invalidated immediately when:
 *       - a user is banned            (via invalidateUserCache(userId))
 *       - an admin role is changed    (same helper)
 *       - account deletion is queued  (same helper)
 *     TTL is short enough (30 s) that stale data never persists long even
 *     without explicit invalidation.
 *
 *  ✅ FIX: lastActive write throttling (once per LAST_ACTIVE_THROTTLE_MS).
 *     The previous code fired a DB write on every single authenticated
 *     request, including high-frequency reads (notification polling, feed
 *     refresh, socket reconnects). At scale this is a write amplification
 *     problem. Now the write is skipped if we updated lastActive for this
 *     user within the throttle window. Throttle state is stored in the same
 *     in-memory Map as the user cache so there's no extra allocation.
 *
 *  ✅ FIX: Scheduled account deletion guard.
 *     If a user has requested account deletion (user.deletion.requested ===
 *     true) they should still be able to authenticate (to cancel the
 *     request) but req.user now carries a `deletionPending` flag and the
 *     `scheduledAt` date so route handlers and the frontend can surface the
 *     "your account will be deleted on X" banner without an extra API call.
 *
 *  ✅ FIX: `blocked` flag checked in addition to `banned`.
 *     adminPostModerationController.blockUser() sets user.blocked = true.
 *     The previous middleware only checked user.banned, so blocked users
 *     could still authenticate. Both flags now cause a 403.
 *
 *  ✅ FIX: ObjectId format validation before DB lookup.
 *     If data.user.id is not a valid 24-hex Mongoose ObjectId, findById()
 *     throws a CastError which bubbles up as a 401 with a confusing message.
 *     We now validate the shape first and return a clean 401 immediately,
 *     avoiding an unnecessary DB round-trip for crafted tokens.
 *
 *  ✅ FIX: JWT algorithm pinned to HS256.
 *     By default jsonwebtoken accepts any algorithm the token header claims.
 *     The "algorithm confusion" (or "alg:none") attack exploits this: a
 *     crafted token with `"alg":"none"` passes verification because the
 *     library accepts the unsigned token as valid. Pinning `algorithms:
 *     ['HS256']` in jwt.verify() options rejects any token whose header
 *     names a different algorithm, closing the attack surface with one line.
 *
 *  ✅ FIX: x-auth-token header support retained but canonicalised.
 *     Some legacy frontend paths send x-auth-token instead of Authorization.
 *     Rather than silently ignoring it, we now try Authorization → x-auth-
 *     token in order and log a deprecation warning on the latter so the team
 *     knows when a client is still using the old header.
 *
 *  ✅ FIX: Structured error codes in addition to human-readable messages.
 *     All 401/403 responses now include an `errorCode` field alongside
 *     `error`. This lets the frontend switch on a stable machine-readable
 *     string (TOKEN_EXPIRED, TOKEN_INVALID, USER_NOT_FOUND, etc.) without
 *     pattern-matching on localised message strings.
 *
 *  ✅ FIX: Cache is exported as a module-level singleton so other modules
 *     (ban handler, admin role change handler) can call
 *     invalidateUserCache(userId) without requiring a separate cache module.
 */

'use strict';

const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const User     = require('../models/User');

// ── Startup guard ─────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * How long (ms) to serve a cached user record before re-fetching from DB.
 * 30 s is a reasonable default: short enough that role changes propagate
 * quickly, long enough to absorb high-frequency polling traffic.
 */
const USER_CACHE_TTL_MS = 30_000;

/**
 * How often (ms) we allow a lastActive DB write per user.
 * 60 s means one write per user per minute at most, regardless of how many
 * requests they make. Actual DB writes are reduced by 10–100× under load.
 */
const LAST_ACTIVE_THROTTLE_MS = 60_000;

// ── In-memory cache ────────────────────────────────────────────────────────────
//
// Shape per entry:
//   {
//     user:          object,   // the req.user shape (plain JS object, no Mongoose)
//     cachedAt:      number,   // Date.now() at cache write
//     lastActiveSentAt: number // Date.now() at last lastActive DB write
//   }
//
// The Map is intentionally module-level (singleton per process).
// In a cluster (PM2, worker_threads), each worker has its own copy — that is
// fine: each worker independently fetches from DB on cache miss and writes
// its own entry, so the worst case is one extra DB fetch per worker on a
// cold-start, not a correctness problem.

/** @type {Map<string, { user: object, cachedAt: number, lastActiveSentAt: number }>} */
const _userCache = new Map();

/**
 * Evict a user from the cache immediately.
 * Call this whenever the user's auth-relevant data changes:
 *   - ban / unban
 *   - role change or permission change
 *   - account deletion requested / cancelled
 *   - blocked / unblocked
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 */
function invalidateUserCache(userId) {
  _userCache.delete(String(userId));
}

/**
 * Evict ALL entries from the cache (e.g. after a bulk role migration).
 * Use sparingly — every subsequent request will hit the DB until the cache
 * warms up again.
 */
function clearUserCache() {
  _userCache.clear();
}

// ── ObjectId validator ────────────────────────────────────────────────────────
//
// Matches exactly 24 hex characters — the only valid Mongoose ObjectId format.
// This avoids a CastError from findById() when tokens contain a crafted id.
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// ── Token extraction ──────────────────────────────────────────────────────────

/**
 * Extract the raw JWT string from the request.
 * Priority: Authorization header → x-auth-token header (legacy, deprecated).
 *
 * Returns { token: string|null, legacy: boolean }.
 * `legacy` is true when the deprecated x-auth-token header was used.
 */
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    // Accept "Bearer <token>" or a bare token
    const raw = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();
    return { token: raw || null, legacy: false };
  }

  // Legacy fallback — some older frontend code sends x-auth-token
  const legacyHeader = req.headers['x-auth-token'];
  if (legacyHeader) {
    return { token: legacyHeader.trim() || null, legacy: true };
  }

  return { token: null, legacy: false };
}

// ── Permission resolution ─────────────────────────────────────────────────────

/**
 * Resolve the effective permission set for a user document.
 * Super-admins get wildcard ['*']; admins get the union of their role
 * permissions and any direct per-user permission overrides.
 *
 * @param {object} user  Mongoose lean/populated user object
 * @returns {string[]}
 */
function resolvePermissions(user) {
  if (user.role === 'super_admin') return ['*'];
  if (user.role === 'admin') {
    const rolePerms = user.adminRole?.permissions ?? [];
    const userPerms = user.adminPermissions       ?? [];
    return [...new Set([...rolePerms, ...userPerms])];
  }
  return [];
}

// ── Main middleware ────────────────────────────────────────────────────────────

const fetchUser = async (req, res, next) => {
  // ── 1. Extract token ─────────────────────────────────────────────────────
  const { token, legacy } = extractToken(req);

  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({
      error:     'Access denied: No token provided.',
      errorCode: 'TOKEN_MISSING',
    });
  }

  if (legacy) {
    // Warn once per request so the team can find and migrate the client code.
    // Not a hard error — the token is still valid.
    console.warn(
      `[fetchUser] Deprecated x-auth-token header used — ` +
      `migrate to "Authorization: Bearer <token>". Path: ${req.method} ${req.path}`
    );
  }

  // ── 2. Structural pre-check (3-segment JWT) ───────────────────────────────
  if (token.split('.').length !== 3) {
    return res.status(401).json({
      error:     'Access denied: Malformed token.',
      errorCode: 'TOKEN_MALFORMED',
    });
  }

  // ── 3. Verify signature + expiry, pin algorithm to HS256 ─────────────────
  let data;
  try {
    data = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error:     'Access denied: Token has expired.',
        errorCode: 'TOKEN_EXPIRED',
      });
    }
    // NotBeforeError, JsonWebTokenError, etc.
    console.warn(`[fetchUser] JWT verification failed (${err.name}): ${err.message}`);
    return res.status(401).json({
      error:     'Access denied: Invalid token.',
      errorCode: 'TOKEN_INVALID',
    });
  }

  // ── 4. Payload shape validation ───────────────────────────────────────────
  const userId = data?.user?.id;
  if (!userId || typeof userId !== 'string') {
    return res.status(401).json({
      error:     'Access denied: Invalid token payload.',
      errorCode: 'TOKEN_PAYLOAD_INVALID',
    });
  }

  // ── 5. ObjectId format check (prevent CastError in findById) ─────────────
  if (!OBJECT_ID_RE.test(userId)) {
    return res.status(401).json({
      error:     'Access denied: Invalid token payload.',
      errorCode: 'TOKEN_PAYLOAD_INVALID',
    });
  }

  // ── 6. Cache lookup ───────────────────────────────────────────────────────
  const now     = Date.now();
  const cached  = _userCache.get(userId);
  const cacheHit = cached && (now - cached.cachedAt) < USER_CACHE_TTL_MS;

  let resolvedUser; // the plain object we attach to req.user

  if (cacheHit) {
    resolvedUser = cached.user;
  } else {
    // ── 7. DB fetch ────────────────────────────────────────────────────────
    let dbUser;
    try {
      dbUser = await User.findById(userId)
        .select('name email role banned blocked deletion adminRole adminPermissions')
        .populate('adminRole', 'permissions roleName')
        .lean();
    } catch (dbErr) {
      // CastError or connection error — fail closed (401 not 500)
      console.error('[fetchUser] DB lookup error:', dbErr.message);
      return res.status(401).json({
        error:     'Access denied: Authentication check failed.',
        errorCode: 'AUTH_DB_ERROR',
      });
    }

    if (!dbUser) {
      // Token is cryptographically valid but the account no longer exists.
      // Invalidate any stale cache entry and respond with a distinct code so
      // the client can redirect to signup rather than the login page.
      invalidateUserCache(userId);
      return res.status(401).json({
        error:     'Access denied: Account not found.',
        errorCode: 'USER_NOT_FOUND',
      });
    }

    // ── 8. Account status gates ───────────────────────────────────────────
    // Checked on every DB fetch (cache miss), so these take effect within
    // USER_CACHE_TTL_MS of the admin action that set the flag.
    //
    // BUG FIX: `banned` is a Mongoose sub-document, NOT a plain Boolean.
    // The User schema defines it as:
    //   banned: { isBanned: { type: Boolean, default: false }, ... }
    //
    // Because Mongoose always instantiates declared sub-documents, `dbUser.banned`
    // is ALWAYS a non-null object like { isBanned: false, reason: null, ... } —
    // even for users who have never been banned. A non-null object is truthy in
    // JavaScript, so the old check `if (dbUser.banned)` evaluated to true for
    // EVERY user on every cache miss, blocking all socket connections and
    // returning 403 "Account restricted" for every authenticated request.
    //
    // Correct check: read the nested `isBanned` boolean, not the container object.
    // `blocked` is a plain top-level Boolean so its check is unchanged.
    if (dbUser.banned?.isBanned || dbUser.blocked) {
      // Do not cache — banned/blocked state should propagate immediately.
      invalidateUserCache(userId);
      return res.status(403).json({
        error:     'Account restricted.',
        errorCode: 'ACCOUNT_RESTRICTED',
      });
    }

    const isSuperAdmin = dbUser.role === 'super_admin';
    const permissions  = resolvePermissions(dbUser);

    resolvedUser = {
      id:              userId,
      name:            dbUser.name,
      email:           dbUser.email,
      role:            dbUser.role,
      isAdmin:         dbUser.role === 'admin' || isSuperAdmin,
      isSuperAdmin,
      permissions,
      adminRoleName:   dbUser.adminRole?.roleName ?? null,
      // Deletion state — surfaced so routes/frontend can show the grace-period banner
      deletionPending:    !!dbUser.deletion?.requested,
      deletionScheduledAt: dbUser.deletion?.scheduledAt ?? null,
    };

    // ── 9. Populate cache ─────────────────────────────────────────────────
    _userCache.set(userId, {
      user:              resolvedUser,
      cachedAt:          now,
      // Preserve prior throttle timestamp if this is a cache refresh, not
      // a first-ever entry, so we don't accidentally reset the write window.
      lastActiveSentAt:  cached?.lastActiveSentAt ?? 0,
    });
  }

  // ── 10. Attach to request ─────────────────────────────────────────────────
  req.user = resolvedUser;

  // ── 11. lastActive write (throttled, fire-and-forget) ────────────────────
  // Refresh the cache entry's lastActiveSentAt so subsequent requests within
  // the throttle window skip the write.
  const entry = _userCache.get(userId); // always present after step 9
  const lastActiveSentAt = entry?.lastActiveSentAt ?? 0;

  if (now - lastActiveSentAt >= LAST_ACTIVE_THROTTLE_MS) {
    // Update in-memory timestamp immediately (before the async write) so
    // concurrent in-flight requests in the same process see the updated
    // throttle timestamp and don't all fire their own DB writes.
    if (entry) entry.lastActiveSentAt = now;

    User.findByIdAndUpdate(userId, { lastActive: new Date(now) }).catch(err =>
      console.error('[fetchUser] lastActive update failed:', err.message)
    );
  }

  next();
};

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = fetchUser;
module.exports.invalidateUserCache = invalidateUserCache;
module.exports.clearUserCache      = clearUserCache;
// Expose for tests / health-check tooling
module.exports._cache              = _userCache;