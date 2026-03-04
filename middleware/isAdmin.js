// middlewares/isAdmin.js
//
// FIX: Was checking `user.isAdmin` (a boolean defaulting to `false` for ALL users).
// The real source-of-truth is the `role` field (enum: 'user' | 'admin').
// fetchuser.js already sets req.user.isAdmin = (user.role === 'admin'), so we
// can check that directly without a second DB round-trip.

const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  next();
};

module.exports = isAdmin;