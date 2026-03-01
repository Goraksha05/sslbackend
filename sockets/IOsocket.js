// backend/sockets/IOsocket.js
//
// Responsibilities:
//   • Create and configure the Socket.IO server
//   • Apply auth middleware
//   • Auto-join personal room
//   • Handle match-suggestion broadcasts (city/hometown)
//   • Delegate ALL other events to onConnection.js
//
// Presence tracking and messaging logic live in onConnection.js only.

const { Server }       = require("socket.io");
const Profile          = require("../models/Profile");
const verifySocketUser = require("../middleware/verifySocketUser");
const onConnection     = require("./handlers/onConnection");

let io;

function initializeSocket(server) {
  const CORS_ORIGINS = (
    process.env.FRONTEND_BASE_URL ||
    "http://127.0.0.1:3000,https://sosholife.com"
  )
    .split(",")
    .map((o) => o.trim());

  io = new Server(server, {
    cors: {
      origin: CORS_ORIGINS,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE"],
    },
    path: "/socket.io",
    // Let Socket.IO handle its own pings so clients know quickly when they drop
    pingInterval: 25_000,
    pingTimeout:  20_000,
  });

  // ── Auth middleware ─────────────────────────────────────────────────────────
  io.use(verifySocketUser);

  // ── Connection handler ──────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    const userId   = socket.user?._id?.toString() ?? socket.user?.id?.toString();
    const userName = socket.user?.name;

    if (!userId) {
      console.warn("[IOsocket] Socket connected without valid user — disconnecting.");
      socket.disconnect();
      return;
    }

    console.log(`✅ [IOsocket] Connected: ${userName} (${userId})`);

    // Auto-join personal room (used by notifyUser, friend requests, etc.)
    socket.join(userId);

    // ── Match-suggestion broadcast (city/hometown) ───────────────────────────
    //   Emitted by the client once after connecting to trigger the broadcast.
    //   This is the ONLY user-online handler in the system.
    socket.on("user-online", async (payload) => {
      if (!payload || typeof payload !== "object") return;

      const { hometown, currentcity } = payload;
      if (!hometown && !currentcity) return;

      try {
        const matchConditions = [];
        if (hometown)     matchConditions.push({ hometown });
        if (currentcity)  matchConditions.push({ currentcity });

        const matches = await Profile.aggregate([
          {
            $match: {
              user_id: { $ne: socket.user._id },
              $or: matchConditions,
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "user_id",
              foreignField: "_id",
              as: "user",
            },
          },
          { $unwind: "$user" },
          { $project: { _id: "$user._id", name: "$user.name" } },
        ]);

        matches.forEach((match) => {
          io.to(match._id.toString()).emit("notification", {
            type: "match_suggestion",
            message: `${userName} just joined and shares your city or hometown!`,
            from: userId,
          });
        });

        if (matches.length > 0) {
          console.log(
            `📢 [IOsocket] Match suggestions sent to ${matches.length} users for ${userName}`
          );
        }
      } catch (err) {
        console.error("[IOsocket] user-online match broadcast error:", err.message);
      }
    });

    // ── Explicit logout signal ───────────────────────────────────────────────
    socket.on("user-offline", (emittedUserId) => {
      if (emittedUserId && emittedUserId.toString() === userId) {
        // Presence cleanup is handled by the "disconnect" handler in onConnection.
        // Just disconnect the socket; the rest follows automatically.
        socket.disconnect();
      }
    });

    // ── Delegate all other events to onConnection ────────────────────────────
    onConnection(io, socket);
  });
}

function getIO() {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initializeSocket() first.");
  }
  return io;
}

module.exports = { initializeSocket, getIO };