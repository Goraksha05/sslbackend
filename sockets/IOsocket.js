// ✅ Enhanced IOsocket.js for secure socket auth via refreshToken cookie
const { Server } = require('socket.io');
const Profile = require('../models/Profile');
const verifySocketUser = require('../middleware/verifySocketUser');
const onConnection = require('./handlers/onConnection');

let io;

function initializeSocket(server) {
  io = new Server(server, {
    cors: {
      origin: ['http://127.0.0.1:3000', 'https://sosholife.com'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
    path: '/socket.io'
  });

  // ✅ Middleware: secure authentication using refreshToken from cookies
  io.use(verifySocketUser);

  io.on('connection', (socket) => {
    const userId = socket?.user?.id;
    const userName = socket?.user?.name;

    if (!userId) {
      console.warn('Socket connected without valid user.');
      socket.disconnect();
      return;
    }

    console.log(`✅ Socket connected: ${userName} (${userId})`);

    // Auto-join personal room
    socket.join(userId);

    // Join specific room
    socket.on('join-room', (roomId) => {
      if (roomId) {
        socket.join(roomId);
        console.log(`📥 ${userName} joined room: ${roomId}`);
      }
    });

    // 🔔 Emit match suggestions to other users with same hometown/city
    socket.on('user-online', async (payload) => {
      if (!payload || typeof payload !== 'object') {
        console.warn('⚠️ Invalid payload for user-online:', payload);
        return;
      }

      const { hometown, currentcity } = payload;

      try {
        const matches = await Profile.aggregate([
          {
            $match: {
              user_id: { $ne: socket.user.id },
              $or: [
                { hometown: hometown || null },
                { currentcity: currentcity || null }
              ]
            }
          },
          {
            $lookup: {
              from: 'users',
              localField: 'user_id',
              foreignField: '_id',
              as: 'user'
            }
          },
          { $unwind: '$user' },
          {
            $project: {
              _id: '$user._id',
              name: '$user.name'
            }
          }
        ]);

        matches.forEach(match => {
          io.to(match._id.toString()).emit('notification', {
            type: 'match_suggestion',
            message: `${userName} just joined and shares your city or hometown!`,
            from: userId
          });
        });

        console.log(`📢 Match suggestions sent to ${matches.length} users.`);
      } catch (err) {
        console.error('❌ Error in user-online match broadcast:', err.message);
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ Socket disconnected: ${userName} (${userId})`);
    });

    onConnection(io, socket);
  });
}

function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}

module.exports = { initializeSocket, getIO };
