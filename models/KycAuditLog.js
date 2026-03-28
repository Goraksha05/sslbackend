const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  kyc: { type: mongoose.Schema.Types.ObjectId, ref: 'KYC' },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  action: String,
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  meta: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

module.exports = mongoose.model('KycAuditLog', schema);