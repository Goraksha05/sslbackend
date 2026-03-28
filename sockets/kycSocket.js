const { getIO } = require('./IOsocket');

function emitKycUpdate({ type, kycId, userId }) {
  try {
    const io = getIO();

    if (userId) {
      io.to(userId.toString()).emit('kyc:user_update', { type, kycId });
    }

    io.to('admin_kyc_room').emit('kyc:admin_update', {
      type,
      kycId,
      userId,
    });

  } catch (err) {
    console.error('[kycSocket]', err.message);
  }
}

function emitKycBulkUpdate({ type, ids }) {
  try {
    const io = getIO();

    io.to('admin_kyc_room').emit('kyc:bulk_update', { type, ids });

  } catch (err) {}
}

function emitKycStatsUpdate({ type }) {
  try {
    const io = getIO();
    io.to('admin_kyc_room').emit('kyc:stats_update', { type });
  } catch (err) {}
}

function handleKycAdminJoin(socket) {
  socket.on('join_kyc_admin', () => {
    socket.join('admin_kyc_room');
  });
}

module.exports = {
  emitKycUpdate,
  emitKycBulkUpdate,
  emitKycStatsUpdate,
  handleKycAdminJoin
};