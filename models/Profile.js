const mongoose = require('mongoose');
const { Schema } = mongoose;

// FIX: Normalised enum values to be consistent across the entire stack.
// The original model had 'Prefered not to mention' (one 'r') but the frontend
// was sending 'Prefer not to mention' (two 'r's), causing silent validation
// failures where the field was never actually saved.
const SEX_ENUM = ['Male', 'Female', 'Prefered not to mention'];
const RELATIONSHIP_ENUM = ['Single', 'Married', 'Prefered not to mention'];

const ProfileSchema = new Schema({

  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true,
    // FIX: Added index so profile lookups by user_id are fast (this is the
    // most common query in the entire profile system).
    index: true,
    unique: true
  },

  dob: {
    type: Date
  },

  profileavatar: {
    URL: { type: String, default: '' },
    type: {
      type: String,
      enum: ['image', 'video', 'file'],
      default: 'image'
    }
  },

  currentcity: { type: String, default: '' },
  hometown: { type: String, default: '' },

  sex: {
    type: String,
    enum: SEX_ENUM,
    default: 'Prefered not to mention'
  },

  relationship: {
    type: String,
    enum: RELATIONSHIP_ENUM,
    default: 'Prefered not to mention'
  },

  coverImage: { type: String, default: '' },

  sosholifejoinedon: {
    type: Date,
    default: Date.now
  },

  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user'
  }],

  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user'
  }],

  settings: {
    privacy: {
      showEmail: { type: Boolean, default: true },
      showDOB: { type: Boolean, default: false },
      showLocation: { type: Boolean, default: true },
      allowSearchByName: { type: Boolean, default: true }
    },
    notifications: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: false },
      sms: { type: Boolean, default: false },
      mentionsOnly: { type: Boolean, default: true }
    }
  }

}, {
  // FIX: Added timestamps so we get createdAt / updatedAt for free, useful
  // for debugging and analytics without any extra code.
  timestamps: true
});

const Profile = mongoose.model('profile', ProfileSchema);
module.exports = Profile;