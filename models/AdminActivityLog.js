// models/AdminActivityLog.js
const mongoose = require('mongoose');

const AdminActivityLogSchema = new mongoose.Schema(
  {
    adminId:    { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, index: true },
    adminEmail: { type: String },
    action:     { type: String, required: true, index: true },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    targetEmail:{ type: String, default: null },
    details:    { type: mongoose.Schema.Types.Mixed, default: {} },
    ip:         { type: String },
  },
  { timestamps: true }
);

AdminActivityLogSchema.index({ createdAt: -1 });
AdminActivityLogSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('AdminActivityLog', AdminActivityLogSchema);