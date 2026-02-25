// backfillFriendships.js
require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
const User = require('../models/User');
const Friendship = require('../models/Friendship');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sosholife';

(async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // Find all users that were referred by someone
    const referredUsers = await User.find({ referral: { $ne: null } })
      .populate('referral', 'name');

    console.log(`🔍 Found ${referredUsers.length} referred users`);

    let createdCount = 0;

    for (const user of referredUsers) {
      const referrer = user.referral;
      if (!referrer) continue;

      // Check if friendship already exists
      const existing = await Friendship.findOne({
        $or: [
          { requester: referrer._id, recipient: user._id },
          { requester: user._id, recipient: referrer._id }
        ]
      });

      if (!existing) {
        await Friendship.create({
          requester: referrer._id,
          recipient: user._id,
          status: 'accepted'
        });

        console.log(`[notification] ${referrer.name} and ${user.name} are now friends (backfill).`);
        createdCount++;
      }
    };

    console.log(`🎉 Backfill complete. Friendships created: ${createdCount}`);
    process.exit(0);

  } catch (err) {
    console.error("❌ Error in backfill:", err);
    process.exit(1);
  }
})();
