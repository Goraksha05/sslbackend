require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
const User = require('../models/User');

(async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);

    console.log('Connected.');

    // Import buildReferralId from User.js without duplicating logic
    const { buildReferralId } = require('../models/User');

    const usersWithoutReferral = await User.find({
      $or: [{ referralId: { $exists: false } }, { referralId: null }]
    });

    console.log(`Found ${usersWithoutReferral.length} users without referralId.`);

    for (const user of usersWithoutReferral) {
      try {
        const referralId = await buildReferralId(user.name, user._id, User);
        user.referralId = referralId;
        await user.save();
        console.log(`✅ Updated ${user.name} (${user._id}) with referralId: ${user.referralId}`);
      } catch (err) {
        console.error(`❌ Failed for ${user.name} (${user._id}):`, err.message);
      }
    }

    console.log('Backfill complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
})();
