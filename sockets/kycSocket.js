// backend/sockets/kycSocket.js
//
// Broadcasts KYC lifecycle events to the relevant Socket.IO rooms.
//
// Room naming — single source of truth:
//   KYC_ADMIN_ROOM is defined HERE and exported so IOsocket.js can import
//   it for the auto-join-on-connect logic. This guarantees both sides always
//   reference the same string and a rename only requires one edit.

'use strict';

const { getIO } = require('./socketManager');

// ─── Room constant ────────────────────────────────────────────────────────────
// All admin-panel KYC dashboard clients join this room.
// Exported so IOsocket.js can auto-join admin sockets to it on connect.
const KYC_ADMIN_ROOM = 'kyc_admins';

// ─── Per-user update ──────────────────────────────────────────────────────────
// Notify the affected user AND all admins watching the dashboard.
function emitKycUpdate({ type, kycId, userId }) {
  try {
    const io = getIO();

    // Tell the specific user their KYC status changed (shown as a banner/badge
    // in the user panel via KycContext.jsx → refetch()).
    if (userId) {
      io.to(userId.toString()).emit('kyc:user_update', { type, kycId });
    }

    // Tell all admins in the dashboard so the record row updates in real time.
    io.to(KYC_ADMIN_ROOM).emit('kyc:admin_update', { type, kycId, userId });
  } catch (err) {
    console.error('[kycSocket] emitKycUpdate error:', err.message);
  }
}

// ─── Bulk update ──────────────────────────────────────────────────────────────
// Used after bulk approve / bulk reject actions.
function emitKycBulkUpdate({ type, ids }) {
  try {
    const io = getIO();
    io.to(KYC_ADMIN_ROOM).emit('kyc:bulk_update', { type, ids });
  } catch (err) {
    console.error('[kycSocket] emitKycBulkUpdate error:', err.message);
  }
}

// ─── Stats update ─────────────────────────────────────────────────────────────
// Increments / decrements the stats cards on the admin KYC dashboard.
function emitKycStatsUpdate({ type }) {
  try {
    const io = getIO();
    io.to(KYC_ADMIN_ROOM).emit('kyc:stats_update', { type });
  } catch (err) {
    console.error('[kycSocket] emitKycStatsUpdate error:', err.message);
  }
}

// ─── Manual room join ─────────────────────────────────────────────────────────
// Called from onConnection.js for every connected socket.
// Registers a listener for 'join_kyc_admin' so admin-panel clients can
// explicitly join the room (e.g. after a page navigation that remounts
// AdminKycContext). This is a belt-and-suspenders complement to the
// auto-join that IOsocket.js already performs on connect for isAdmin sockets.
function handleKycAdminJoin(socket) {
  socket.on('join_kyc_admin', () => {
    socket.join(KYC_ADMIN_ROOM);
    console.log(`[kycSocket] Socket ${socket.id} joined ${KYC_ADMIN_ROOM} via event`);
  });
}

module.exports = {
  KYC_ADMIN_ROOM,      // ← imported by IOsocket.js
  emitKycUpdate,
  emitKycBulkUpdate,
  emitKycStatsUpdate,
  handleKycAdminJoin,
};