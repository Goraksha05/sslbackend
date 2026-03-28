const KYC = require('../models/KYC');
const User = require('../models/User');
const KycAuditLog = require('../models/KycAuditLog');
const { v4: uuidv4 } = require('uuid');

const {
  emitKycUpdate,
  emitKycBulkUpdate,
  emitKycStatsUpdate
} = require('../socket/kycSocket');

// CREATE
exports.createKyc = async (userId, data) => {
  const kyc = new KYC({
    user: userId,
    submissionId: `KYC-${uuidv4()}`,
    ...data,
    history: [{ action: 'submitted', by: userId }]
  });

  await kyc.save();

  emitKycStatsUpdate({ type: 'submitted' });

  return kyc;
};

// LIST
exports.getList = async ({ status, page = 1, limit = 20 }) => {
  const query = { isLatest: true };
  if (status) query.status = status;

  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    KYC.find(query).populate('user').skip(skip).limit(limit).lean(),
    KYC.countDocuments(query)
  ]);

  return {
    records,
    pagination: {
      page,
      pages: Math.ceil(total / limit),
      total
    }
  };
};

// APPROVE
exports.approve = async (id, adminId) => {
  const kyc = await KYC.findById(id);

  kyc.status = 'verified';
  kyc.review = { reviewedBy: adminId, reviewedAt: new Date() };

  await kyc.save();

  await KycAuditLog.create({
    kyc: id,
    user: kyc.user,
    action: 'approved',
    performedBy: adminId
  });

  emitKycUpdate({ type: 'approved', kycId: id, userId: kyc.user });
  emitKycStatsUpdate({ type: 'approved' });

  return kyc;
};

// REJECT
exports.reject = async (id, adminId, reason) => {
  const kyc = await KYC.findById(id);

  kyc.status = 'rejected';
  kyc.review = { reviewedBy: adminId, reviewedAt: new Date(), rejectionReason: reason };

  await kyc.save();

  await KycAuditLog.create({
    kyc: id,
    user: kyc.user,
    action: 'rejected',
    performedBy: adminId,
    meta: { reason }
  });

  emitKycUpdate({ type: 'rejected', kycId: id, userId: kyc.user });
  emitKycStatsUpdate({ type: 'rejected' });

  return kyc;
};

// BULK APPROVE
exports.bulkApprove = async (ids, adminId) => {
  const kycs = await KYC.find({ _id: { $in: ids } });

  for (const kyc of kycs) {
    kyc.status = 'verified';
    await kyc.save();

    await KycAuditLog.create({
      kyc: kyc._id,
      user: kyc.user,
      action: 'bulk_approved',
      performedBy: adminId
    });
  }

  emitKycBulkUpdate({ type: 'bulk_approved', ids });
};

// BULK REJECT
exports.bulkReject = async (ids, adminId, reason) => {
  const kycs = await KYC.find({ _id: { $in: ids } });

  for (const kyc of kycs) {
    kyc.status = 'rejected';
    await kyc.save();

    await KycAuditLog.create({
      kyc: kyc._id,
      user: kyc.user,
      action: 'bulk_rejected',
      performedBy: adminId,
      meta: { reason }
    });
  }

  emitKycBulkUpdate({ type: 'bulk_rejected', ids });
};