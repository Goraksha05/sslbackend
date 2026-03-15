// controllers/adminManagementController.js
// Handles:
//   POST   /api/admin/admins              – promote user to admin + assign role
//   GET    /api/admin/admins              – list all admins
//   PUT    /api/admin/admins/:id/role     – change an admin's role
//   DELETE /api/admin/admins/:id          – demote admin → user
//   POST   /api/admin/roles               – create a new AdminRole
//   GET    /api/admin/roles               – list all AdminRoles
//   PUT    /api/admin/roles/:id           – update role permissions
//   DELETE /api/admin/roles/:id           – delete a role
//   GET    /api/admin/audit-logs          – paginated audit log

const User         = require('../models/User');
const AdminRole    = require('../models/AdminRole');
const AdminAuditLog = require('../models/AdminAuditLog');
const { PERMISSIONS } = require('../constants/permissions');
const { writeAudit } = require('../middleware/rbac');

// ── helpers ──────────────────────────────────────────────────────────────────
const ADMIN_SELECT = 'name email role adminRole adminPermissions date lastActive subscription';

// ── Admin CRUD ────────────────────────────────────────────────────────────────

/** GET /api/admin/admins */
exports.listAdmins = async (req, res) => {
  try {
    const admins = await User
      .find({ role: { $in: ['admin', 'super_admin'] } })
      .select(ADMIN_SELECT)
      .populate('adminRole', 'roleName permissions')
      .lean();
    res.json({ admins });
  } catch (err) {
    console.error('[listAdmins]', err);
    res.status(500).json({ message: 'Failed to list admins' });
  }
};

/** POST /api/admin/admins  { email, roleId? } */
exports.promoteAdmin = async (req, res) => {
  const { email, roleId } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot modify the super admin' });
    }

    user.role    = 'admin';
    user.isAdmin = true;
    if (roleId) {
      const role = await AdminRole.findById(roleId);
      if (!role) return res.status(404).json({ message: 'Role not found' });
      user.adminRole = role._id;
    }

    await user.save();

    await writeAudit(req, 'admin_create', { targetEmail: email, roleId });

    res.json({ message: `${email} promoted to admin`, user: { _id: user._id, email: user.email, role: user.role } });
  } catch (err) {
    console.error('[promoteAdmin]', err);
    res.status(500).json({ message: 'Failed to promote user' });
  }
};

/** PUT /api/admin/admins/:id/role  { roleId } */
exports.changeAdminRole = async (req, res) => {
  const { roleId } = req.body;
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: 'Admin not found' });
    if (target.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot modify the super admin' });
    }

    const role = await AdminRole.findById(roleId);
    if (!role) return res.status(404).json({ message: 'Role not found' });

    const oldRole = target.adminRole?.toString();
    target.adminRole = role._id;
    await target.save();

    await writeAudit(req, 'admin_role_change', {
      targetId: target._id,
      targetEmail: target.email,
      fromRole: oldRole,
      toRole: roleId,
    });

    res.json({ message: 'Role updated', adminRole: role.roleName });
  } catch (err) {
    console.error('[changeAdminRole]', err);
    res.status(500).json({ message: 'Failed to change role' });
  }
};

/** DELETE /api/admin/admins/:id */
exports.demoteAdmin = async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: 'Admin not found' });

    if (target.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot demote the super admin' });
    }
    if (target._id.toString() === req.user.id) {
      return res.status(400).json({ message: 'You cannot demote yourself' });
    }

    target.role             = 'user';
    target.isAdmin          = false;
    target.adminRole        = null;
    target.adminPermissions = [];
    await target.save();

    await writeAudit(req, 'admin_delete', { targetId: target._id, targetEmail: target.email });

    res.json({ message: `${target.email} demoted to user` });
  } catch (err) {
    console.error('[demoteAdmin]', err);
    res.status(500).json({ message: 'Failed to demote admin' });
  }
};

// ── Role CRUD (super_admin only) ─────────────────────────────────────────────

/** GET /api/admin/roles */
exports.listRoles = async (req, res) => {
  try {
    const roles = await AdminRole.find().lean();
    res.json({ roles });
  } catch (err) {
    res.status(500).json({ message: 'Failed to list roles' });
  }
};

/** POST /api/admin/roles  { roleName, permissions[], description } */
exports.createRole = async (req, res) => {
  const { roleName, permissions = [], description = '' } = req.body;
  if (!roleName) return res.status(400).json({ message: 'roleName is required' });

  // Validate permission tokens
  const validTokens = Object.values(PERMISSIONS);
  const invalid = permissions.filter(p => !validTokens.includes(p));
  if (invalid.length) {
    return res.status(400).json({ message: `Unknown permissions: ${invalid.join(', ')}` });
  }

  try {
    const role = await AdminRole.create({
      roleName: roleName.trim(),
      permissions,
      description,
      createdBy: req.user.id,
    });
    await writeAudit(req, 'role_created', { roleName, permissions });
    res.status(201).json({ message: 'Role created', role });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Role name already exists' });
    console.error('[createRole]', err);
    res.status(500).json({ message: 'Failed to create role' });
  }
};

/** PUT /api/admin/roles/:id  { permissions[], description } */
exports.updateRole = async (req, res) => {
  const { permissions, description } = req.body;
  try {
    const role = await AdminRole.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found' });

    if (permissions !== undefined) role.permissions = permissions;
    if (description !== undefined) role.description  = description;
    await role.save();

    await writeAudit(req, 'role_updated', { roleId: role._id, roleName: role.roleName, permissions });
    res.json({ message: 'Role updated', role });
  } catch (err) {
    console.error('[updateRole]', err);
    res.status(500).json({ message: 'Failed to update role' });
  }
};

/** DELETE /api/admin/roles/:id */
exports.deleteRole = async (req, res) => {
  try {
    const role = await AdminRole.findByIdAndDelete(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found' });

    // Clear this role from all admins who had it
    await User.updateMany({ adminRole: req.params.id }, { $set: { adminRole: null } });

    await writeAudit(req, 'role_deleted', { roleId: req.params.id, roleName: role.roleName });
    res.json({ message: 'Role deleted' });
  } catch (err) {
    console.error('[deleteRole]', err);
    res.status(500).json({ message: 'Failed to delete role' });
  }
};

// ── Audit Logs ────────────────────────────────────────────────────────────────

/** GET /api/admin/audit-logs?page=1&limit=50&action= */
exports.getAuditLogs = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.adminId) filter.adminId = req.query.adminId;

    const [logs, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[getAuditLogs]', err);
    res.status(500).json({ message: 'Failed to fetch audit logs' });
  }
};