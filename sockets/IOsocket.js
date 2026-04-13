// backend/sockets/IOsocket.js
//
// Single Socket.IO server that handles BOTH user-panel and admin-panel clients.
//
// Responsibilities:
//   • Create and configure the Socket.IO server
//   • Apply JWT auth middleware (verifySocketUser)
//   • Auto-join every socket to its personal userId room
//   • Auto-join admin sockets to KYC_ADMIN_ROOM (imported from kycSocket.js)
//   • Handle match-suggestion broadcasts (city/hometown)
//   • Delegate ALL other events to onConnection.js
//
// Room naming — single source of truth:
//   KYC_ADMIN_ROOM is defined and exported from kycSocket.js.
//   IOsocket.js imports it here so the auto-join on connect and the emit
//   inside kycSocket.js always reference the same string. The previous bug
//   was that IOsocket.js hardcoded "kyc_admins" while kycSocket.js emitted
//   to "admin_kyc_room", so every KYC broadcast went into an empty room.

'use strict';

const { Server }         = require("socket.io");
const Profile            = require("../models/Profile");
const verifySocketUser   = require("../middleware/verifySocketUser");
const onConnection       = require("./handlers/onConnection");
const { KYC_ADMIN_ROOM } = require("./kycSocket");
const { setIO } = require("./socketManager");

let io;

// ─── initializeSocket ─────────────────────────────────────────────────────────
// Called once at server startup: server.js does
//   const { initializeSocket } = require('./sockets/IOsocket');
//   initializeSocket(httpServer);
function initializeSocket(server) {
  const CORS_ORIGINS = (
    process.env.FRONTEND_BASE_URL
    // "http://127.0.0.1:3000,http://127.0.0.1:3001,https://sosholife.com"
  )
    .split(",")
    .map((o) => o.trim());

  const ioInstance = new Server(server, {
    cors: {
      origin:      CORS_ORIGINS,
      credentials: true,
      methods:     ["GET", "POST", "PUT", "DELETE"],
    },
    path:         "/socket.io",
    pingInterval: 25_000,
    pingTimeout:  20_000,
  });
  setIO(ioInstance);

  io = ioInstance;
  // ── Auth middleware ───────────────────────────────────────────────────────
  // verifySocketUser reads socket.handshake.auth.token, verifies the JWT,
  // and attaches the decoded user to socket.user.
  // This runs for BOTH user-panel and admin-panel connections — no separate
  // namespace is needed because the JWT's role field distinguishes them.

  io.use(verifySocketUser);

  // ── Connection handler ────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    // verifySocketUser populates socket.user from the JWT payload.
    // Support both Mongoose ObjectId shapes (_id and id).
    const userId   = socket.user?._id?.toString() ?? socket.user?.id?.toString();
    const userRole = socket.user?.role;   // "user" | "admin" | "super_admin"
    const userName = socket.user?.name;

    if (!userId) {
      console.warn("[IOsocket] Socket connected without valid user — disconnecting.");
      socket.disconnect();
      return;
    }

    console.log(`✅ [IOsocket] Connected: ${userName} (${userId}) role=${userRole}`);

    // ── Personal room ─────────────────────────────────────────────────────
    // Every socket (user and admin) joins its own userId room so targeted
    // events (e.g. kyc:user_update, direct notifications) can be delivered
    // without broadcasting to everyone.
    socket.join(userId);

    // ── Admin KYC room (auto-join) ────────────────────────────────────────
    // Admin-panel clients also join KYC_ADMIN_ROOM automatically on connect
    // so they receive kyc:* broadcasts immediately — even before (or if) the
    // client-side AdminKycContext emits 'join_kyc_admin'.
    //
    // We check both `isAdmin` (boolean set by some auth paths) and `role`
    // (the canonical source of truth on the User model) so neither path is
    // missed.
    const isAdmin =
      socket.user?.isAdmin === true ||
      userRole === "admin"          ||
      userRole === "super_admin";

    if (isAdmin) {
      socket.join(KYC_ADMIN_ROOM);
      console.log(`👑 [IOsocket] Admin auto-joined ${KYC_ADMIN_ROOM}: ${userId}`);
    }

    // ── Match-suggestion broadcast ────────────────────────────────────────
    // User-panel feature: when a user comes online, notify other users who
    // share the same city or hometown.
    socket.on("user-online", async (payload) => {
      if (!payload || typeof payload !== "object") return;

      const { hometown, currentcity } = payload;
      if (!hometown && !currentcity) return;

      try {
        const matchConditions = [];
        if (hometown)    matchConditions.push({ hometown });
        if (currentcity) matchConditions.push({ currentcity });

        const matches = await Profile.aggregate([
          {
            $match: {
              user_id: { $ne: socket.user._id },
              $or: matchConditions,
            },
          },
          {
            $lookup: {
              from:         "users",
              localField:   "user_id",
              foreignField: "_id",
              as:           "user",
            },
          },
          { $unwind: "$user" },
          { $project: { _id: "$user._id", name: "$user.name" } },
        ]);

        matches.forEach((match) => {
          io.to(match._id.toString()).emit("notification", {
            type:    "match_suggestion",
            message: `${userName} just joined and shares your city or hometown!`,
            from:    userId,
          });
        });
      } catch (err) {
        console.error("[IOsocket] user-online match broadcast error:", err.message);
      }
    });

    // ── Logout ────────────────────────────────────────────────────────────
    socket.on("user-offline", (emittedUserId) => {
      if (emittedUserId && emittedUserId.toString() === userId) {
        socket.disconnect();
      }
    });

    // ── Delegate all other events ─────────────────────────────────────────
    // onConnection.js handles: messaging, presence, reactions, etc.
    // It also calls handleKycAdminJoin(socket) from kycSocket.js, which
    // registers the 'join_kyc_admin' listener as a manual fallback for
    // clients that emit it explicitly.
    onConnection(io, socket);
  });
}

module.exports = { initializeSocket };