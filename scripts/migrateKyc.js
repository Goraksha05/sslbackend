const mongoose = require('mongoose');
const User = require('../models/User');
const KYC = require('../models/KYC');

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({ 'kyc.status': { $exists: true } });

  for (const user of users) {

    const existing = await KYC.findOne({ user: user._id });
    if (existing) continue;

    const kyc = new KYC({
      user: user._id,
      submissionId: `MIG-${Date.now()}-${user._id}`,
      status: user.kyc.status,
      documents: {
        aadhaar: { file: user.kyc.documents?.aadhaarFile },
        pan:     { file: user.kyc.documents?.panFile },
        bank:    { file: user.kyc.documents?.bankPassbookFile },
        selfie:  { file: user.kyc.documents?.selfie },
      },
      review: {
        reviewedAt: user.kyc.verifiedAt,
        rejectionReason: user.kyc.rejectionReason,
      },
      createdAt: user.kyc.submittedAt || new Date(),
    });

    await kyc.save();

    user.kycLatest = kyc._id;
    await user.save();
  }

  console.log('✅ Migration complete');
  process.exit();
}

migrate();