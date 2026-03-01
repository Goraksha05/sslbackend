const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;

// FIX: Removed hardcoded fallback secret — same security fix as fetchuser.js
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

const verifySocketUser = async (socket, next) => {
  try {
    let token = socket.handshake.auth?.token;

    if (!token) {
      console.warn('verifySocketUser: no token in socket handshake.');
      return next(new Error('Unauthorized: Token missing'));
    }

    // Clean the token: remove whitespace and line breaks
    token = token.trim().replace(/\s/g, '');

    if (token.split('.').length !== 3) {
      console.error('verifySocketUser: malformed token structure');
      return next(new Error('Unauthorized: Malformed token'));
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = decoded.user?.id;
    if (!userId) {
      return next(new Error('Unauthorized: Invalid token payload'));
    }

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return next(new Error('Unauthorized: User not found'));
    }

    // FIX: Reject banned users at the socket layer too, consistent with fetchuser.js
    if (user.banned) {
      return next(new Error('Unauthorized: Account restricted'));
    }

    socket.user = user;
    next();

  } catch (error) {
    // FIX: Distinguish expired tokens so clients can decide to refresh vs hard logout
    if (error.name === 'TokenExpiredError') {
      return next(new Error('Unauthorized: Token has expired'));
    }
    console.error('verifySocketUser: auth failed:', error.message);
    return next(new Error('Unauthorized: Invalid or expired token'));
  }
};

module.exports = verifySocketUser;