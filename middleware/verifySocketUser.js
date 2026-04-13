// middleware/verifySocketUser.js
//
// Socket.IO auth middleware — runs once per connection handshake.
//
// The client sends its JWT inside socket.handshake.auth.token (set by
// WebSocketClient.js: io(SERVER_URL, { auth: { token } })).
//
// On success:  populates socket.user and calls next()
// On failure:  calls next(new Error(message)) — Socket.IO sends a
//              connect_error event to the client with err.message as the
//              reason string. WebSocketClient.js logs it at line 118:
//                [Socket] Connection error: <message>
//
// ─────────────────────────────────────────────────────────────────────────────
// BUG FIXED: `dbUser.banned` is a Mongoose sub-document, NOT a Boolean.
//
// The User schema declares:
//   banned: { isBanned: { type: Boolean, default: false }, ... }
//
// Mongoose always instantiates declared sub-documents. Even for a user who
// has never been banned, `dbUser.banned` is a non-null object:
//   { isBanned: false, reason: null, bannedAt: null, ... }
//
// A non-null object is truthy in JavaScript. The previous check was:
//   if (user.banned || user.blocked)
//
// This made the condition always true, so EVERY socket handshake was
// rejected with "Unauthorized: Account restricted" — including completely
// normal, never-banned users. The user panel console showed:
//   [Socket] Connection error: Unauthorized: Account restricted
//
// Fix: check the nested boolean `user.banned?.isBanned`, not the container object.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const User     = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const verifySocketUser = async (socket, next) => {
  try {
    // ── 1. Extract token from handshake ───────────────────────────────────
    const token = socket.handshake.auth?.token;

    if (!token || token === 'null' || token === 'undefined') {
      return next(new Error('Unauthorized: No token provided'));
    }

    // ── 2. Structural pre-check ───────────────────────────────────────────
    if (token.split('.').length !== 3) {
      return next(new Error('Unauthorized: Malformed token'));
    }

    // ── 3. Verify signature + expiry, pin to HS256 ────────────────────────
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      // Surface "jwt expired" verbatim so WebSocketClient.js can detect it
      // and trigger a token refresh (see connect_error handler in WebSocketClient.js).
      if (err.name === 'TokenExpiredError') {
        return next(new Error('jwt expired'));
      }
      return next(new Error('Unauthorized: Invalid token'));
    }

    // ── 4. Payload shape validation ───────────────────────────────────────
    const userId = decoded?.user?.id;
    if (!userId || typeof userId !== 'string') {
      return next(new Error('Unauthorized: Invalid token payload'));
    }

    // ── 5. ObjectId format check (prevent CastError in findById) ─────────
    if (!OBJECT_ID_RE.test(userId)) {
      return next(new Error('Unauthorized: Invalid token payload'));
    }

    // ── 6. DB lookup ──────────────────────────────────────────────────────
    let user;
    try {
      user = await User.findById(userId)
        .select('name email role banned blocked adminRole adminPermissions')
        .populate('adminRole', 'permissions roleName')
        .lean();
    } catch (dbErr) {
      console.error('[verifySocketUser] DB error:', dbErr.message);
      return next(new Error('Unauthorized: Authentication check failed'));
    }

    if (!user) {
      return next(new Error('Unauthorized: Account not found'));
    }

    // ── 7. Account status gates ───────────────────────────────────────────
    //
    // BUG FIX: `user.banned` is a Mongoose sub-document object, not a boolean.
    // It is ALWAYS truthy (even when isBanned is false) because Mongoose
    // instantiates declared sub-documents regardless of their field values.
    //
    // WRONG (previous code):
    //   if (user.banned || user.blocked)   ← always true, blocks everyone
    //
    // CORRECT:
    //   if (user.banned?.isBanned || user.blocked)
    if (user.banned?.isBanned || user.blocked) {
      return next(new Error('Unauthorized: Account restricted'));
    }

    // ── 8. Attach decoded user to socket ──────────────────────────────────
    // Match the shape that fetchuser.js builds so IOsocket.js handlers
    // that read socket.user.isAdmin, socket.user.role, etc. work consistently.
    const isSuperAdmin = user.role === 'super_admin';

    socket.user = {
      _id:         new mongoose.Types.ObjectId(userId), // ObjectId for aggregation
      id:          userId,                               // string for room names
      name:        user.name,
      email:       user.email,
      role:        user.role,
      isAdmin:     user.role === 'admin' || isSuperAdmin,
      isSuperAdmin,
    };

    next();

  } catch (err) {
    console.error('[verifySocketUser] Unexpected error:', err.message);
    next(new Error('Unauthorized: Internal error'));
  }
};

module.exports = verifySocketUser;