require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
const User = require('../models/User');
const Profile = require('../models/Profile');

// ⚡ Replace with your actual MongoDB URI
const MONGO_URI = process.env.MONGO_URI;

async function cleanupProfiles() {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ Connected to MongoDB');

    // 1. Get all valid user IDs
    const validUserIds = await User.find({}, '_id').lean();
    const validIdsSet = new Set(validUserIds.map(u => u._id.toString()));

    // 2. Find orphan profiles
    const orphanProfiles = await Profile.find().lean();
    const toDelete = orphanProfiles.filter(p => !p.user_id || !validIdsSet.has(p.user_id.toString()));

    if (toDelete.length === 0) {
      console.log('🎉 No orphan profiles found. Database is clean.');
    } else {
      const ids = toDelete.map(p => p._id);
      await Profile.deleteMany({ _id: { $in: ids } });
      console.log(`🗑️ Deleted ${ids.length} orphan profiles.`);
    }

    mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error during cleanup:', err.message);
    mongoose.connection.close();
  }
}

cleanupProfiles();
