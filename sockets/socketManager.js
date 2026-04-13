let io;

const setIO = (instance) => {
  io = instance;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.IO not initialized");
  }
  return io;
};

module.exports = { setIO, getIO };