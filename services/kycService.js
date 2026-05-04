const KYC = require('../models/KYC');
const User = require('../models/User');
const KycAuditLog = require('../models/KycAuditLog');
const { v4: uuidv4 } = require('uuid');

const {
  emitKycUpdate,
  emitKycBulkUpdate,
  emitKycStatsUpdate
} = require('../sockets/kycSocket');

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

  const pageNum  = Math.max(1,   parseInt(page,  10) || 1);
  const limitNum = Math.min(100, parseInt(limit, 10) || 20);
  const skip     = (pageNum - 1) * limitNum;

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
  if (!kyc) throw Object.assign(new Error('KYC record not found'), { status: 404 });
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
  if (!kyc) throw Object.assign(new Error('KYC record not found'), { status: 404 });
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
  const now = new Date();
  const result = await KYC.bulkWrite(
    ids.map(id => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { status: 'verified', 'review.reviewedBy': adminId, 'review.reviewedAt': now } },
      },
    }))
  );
  // Audit log in bulk
  await KycAuditLog.insertMany(ids.map(id => ({
    kyc: id, action: 'bulk_approved', performedBy: adminId
  })));
  emitKycBulkUpdate({ type: 'bulk_approved', ids });
  return { count: result.modifiedCount };
};

// BULK REJECT
exports.bulkReject = async (ids, adminId, reason) => {
  const kycs = await KYC.find({ _id: { $in: ids } }).lean();
  const foundIds = new Set(kycs.map(k => k._id.toString()));
  const missing  = ids.filter(id => !foundIds.has(id));
  if (missing.length) {
    throw Object.assign(new Error(`IDs not found: ${missing.join(', ')}`), { status: 404 });
  }

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