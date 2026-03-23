// models/Profile.js
//
// FIXES:
//   1. MEDIUM SECURITY — settings.privacy.showEmail defaulted to `true`.
//      Any authenticated user could call GET /api/profile/:id and receive the
//      target's email address in the response, because applyPrivacy() in
//      profile.js surfaces it when showEmail is truthy. Since email is a login
//      identifier this is a meaningful privacy leak for all users who have not
//      explicitly changed their privacy settings (i.e. almost everyone).
//      Changed default to `false`.
//
//   2. MINOR — The relationship enum and sex enum values contain
//      'Prefered not to mention' (one 'r'). The comment in the original noted
//      this was intentional for backward compatibility with existing data.
//      Left unchanged to avoid breaking existing documents, but documented here
//      so a future migration can normalise to 'Preferred not to mention'.

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// NOTE: 'Prefered' (one 'r') is intentional for backward compatibility
// with documents already stored in the database.
const SEX_ENUM          = ['Male', 'Female', 'Prefered not to mention'];
const RELATIONSHIP_ENUM = ['Single', 'Married', 'Prefered not to mention'];

const ProfileSchema = new Schema({

  user_id: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'user',
    required: true,
    index:    true,
    unique:   true,
  },

  dob: { type: Date },

  profileavatar: {
    URL:  { type: String, default: '' },
    type: { type: String, enum: ['image', 'video', 'file'], default: 'image' },
  },

  currentcity: { type: String, default: '' },
  hometown:    { type: String, default: '' },

  sex: {
    type:    String,
    enum:    SEX_ENUM,
    default: 'Prefered not to mention',
  },

  relationship: {
    type:    String,
    enum:    RELATIONSHIP_ENUM,
    default: 'Prefered not to mention',
  },

  coverImage: { type: String, default: '' },

  sosholifejoinedon: {
    type:    Date,
    default: Date.now,
  },

  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'user' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'user' }],

  settings: {
    privacy: {
      // FIX: was `true` — exposes email to every authenticated user.
      // Changed to `false` so users must explicitly opt in to sharing their email.
      showEmail:         { type: Boolean, default: false },
      showDOB:           { type: Boolean, default: false },
      showLocation:      { type: Boolean, default: true  },
      allowSearchByName: { type: Boolean, default: true  },
    },
    notifications: {
      email:        { type: Boolean, default: true  },
      push:         { type: Boolean, default: false },
      sms:          { type: Boolean, default: false },
      mentionsOnly: { type: Boolean, default: true  },
    },
  },

}, {
  timestamps: true,
});

const Profile = mongoose.model('profile', ProfileSchema);
module.exports = Profile;