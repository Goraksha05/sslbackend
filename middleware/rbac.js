// middleware/rbac.js
// Three composable middleware functions for the RBAC system.
//
//  verifyAdmin        – allows role: 'admin' OR 'super_admin'
//  verifySuperAdmin   – allows role: 'super_admin' only
//  checkPermission(p) – returns middleware that checks a specific permission
//
// All three assume fetchUser has already run (req.user is populated).

const AdminAuditLog = require('../models/AdminAuditLog');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Does the user's resolved permission set cover the requested permission?
 * Wildcard '*' grants everything.
 */
function hasPermission(user, permission) {
  if (!user || !Array.isArray(user.permissions)) return false;
  return user.permissions.includes('*') || user.permissions.includes(permission);
}

/** Fire-and-forget audit log writer */
async function writeAudit(req, action, details = {}) {
  try {
    await AdminAuditLog.create({
      adminId:     req.user.id,
      adminEmail:  req.user.email,
      action,
      details,
      ip: req.ip || req.headers['x-forwarded-for'] || null,
    });
  } catch (err) {
    console.error('[RBAC] Audit log write failed:', err.message);
  }
}

// ── middleware ────────────────────────────────────────────────────────────────

/**
 * Ensures the caller is at least an admin (admin or super_admin).
 * Drop-in replacement for the old isAdmin middleware — keeps all existing
 * routes working without modification.
 */
const verifyAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

/**
 * Ensures the caller is the super_admin.
 * Use this to protect admin-management, role-management, and migration routes.
 */
const verifySuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin access required.' });
  }
  next();
};

/**
 * Factory that returns an Express middleware checking a single named permission.
 *
 * Usage:
 *   router.get('/users', fetchUser, verifyAdmin, checkPermission('view_users'), handler)
 */
const checkPermission = (permission) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({
      error: `Permission denied. Required: ${permission}`,
    });
  }
  next();
};

module.exports = { verifyAdmin, verifySuperAdmin, checkPermission, hasPermission, writeAudit };