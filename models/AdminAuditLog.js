// models/AdminAuditLog.js
const mongoose = require('mongoose');

const AdminAuditLogSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true,
  },
  adminEmail: { type: String },
  action: {
    type: String,
    required: true,
    // e.g. admin_login, admin_create, admin_delete, admin_role_change,
    //      reward_undo, user_ban, user_suspend, post_delete, role_created
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    default: null,
  },
  targetEmail: { type: String, default: null },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  ip: { type: String, default: null },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

AdminAuditLogSchema.index({ adminId: 1, createdAt: -1 });
AdminAuditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', AdminAuditLogSchema);