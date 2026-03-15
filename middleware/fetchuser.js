require("dotenv").config({ override: true });
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;

// FIX: Fail loudly at startup if the secret is missing rather than silently
// falling back to an insecure hardcoded value.
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

const fetchUser = async (req, res, next) => {
  const authHeader = req.header('Authorization') || req.header('authorization');

  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied: No authorization header provided.' });
  }

  // Support both "Bearer <token>" and raw token formats
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();

  if (!token || token === 'null' || token === 'undefined') {
    console.warn('fetchUser: missing or placeholder token');
    return res.status(401).json({ error: 'Access denied: Token missing or invalid.' });
  }

  // FIX: Moved the malformed-token check BEFORE the try/catch so it returns
  // a proper 401 JSON response instead of calling next(new Error(...)) which
  // would hit Express's default error handler and potentially leak stack traces.
  if (token.split('.').length !== 3) {
    console.warn('fetchUser: malformed JWT received:', JSON.stringify(token));
    return res.status(401).json({ error: 'Access denied: Malformed token.' });
  }

  try {
    const data = jwt.verify(token, JWT_SECRET);

    // FIX: Validate the token payload contains the expected structure before
    // doing a DB lookup to avoid a crash on tokens with unexpected shapes.
    if (!data?.user?.id) {
      return res.status(401).json({ error: 'Access denied: Invalid token payload.' });
    }

    const user = await User.findById(data.user.id).select('name email role banned adminRole adminPermissions').populate('adminRole', 'permissions roleName');

    if (!user) {
      return res.status(401).json({ error: 'Access denied: User not found.' });
    }

    // FIX: Reject requests from banned users at the middleware level so no
    // other route handler needs to remember to check this.
    if (user.banned) {
      return res.status(403).json({ error: 'Account restricted.' });
    }

    const isSuperAdmin = user.role === 'super_admin';
    let permissions = [];
    if (isSuperAdmin) {
      permissions = ['*'];
    } else if (user.role === 'admin') {
      const rolePerms = user.adminRole?.permissions ?? [];
      const userPerms = user.adminPermissions ?? [];
      permissions = [...new Set([...rolePerms, ...userPerms])];
    }

    req.user = {
      id:           user._id.toString(),
      name:         user.name,
      email:        user.email,
      role:         user.role,
      isAdmin:      user.role === 'admin' || isSuperAdmin,
      isSuperAdmin,
      permissions,
      adminRoleName: user.adminRole?.roleName ?? null,
    };

    // Update lastActive (fire-and-forget — do not block the request)
    User.findByIdAndUpdate(data.user.id, { lastActive: Date.now() }).catch(err =>
      console.error('fetchUser: failed to update lastActive:', err.message)
    );

    next();
  } catch (error) {
    // Distinguish expired tokens from other verification errors for better
    // client-side handling (e.g. auto-refresh vs hard logout).
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Access denied: Token has expired.' });
    }
    console.error('fetchUser: JWT validation failed:', error.message);
    return res.status(401).json({ error: 'Access denied: Invalid token.' });
  }
};

module.exports = fetchUser;