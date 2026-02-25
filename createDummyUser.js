// createDummyUser.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config(); // If using .env for DB_URI

// Replace with your actual schema paths
const User = require('./models/User');
const Profile = require('./models/Profile');

// MongoDB connection URI
const MONGO_URI = process.env.MONGO_URI

async function createDummyUser() {
  try {
    await mongoose.connect(MONGO_URI, {
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
    });

    const existingUser = await User.findOne({ email: 'dummy@example.com' });
    if (existingUser) {
      console.log('Dummy user already exists:', existingUser._id);
      process.exit(0);
    }

    const hashedPassword = await bcrypt.hash('dummy123', 10);

    const dummyUser = new User({
      name: 'Dummy Admin',
      username: 'dummyadmin',
      email: 'dummy@example.com',
      phone: '9999999999',
      password: hashedPassword,
      referral: null, // No referrer
    });

    await dummyUser.save();

    await Profile.create({
      user_id: dummyUser._id,
      followers: [],
      following: [],
    });

    console.log('✅ Dummy user created successfully.');
    console.log('🆔 User ID (use this as referralno):', dummyUser._id.toString());
  } catch (err) {
    console.error('Error creating dummy user:', err);
  } finally {
    mongoose.disconnect();
  }
}

createDummyUser();
