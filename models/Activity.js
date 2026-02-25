const mongoose = require('mongoose');
const { Schema } = mongoose;

const ActivitySchema = new Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user'
  },

  referral: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',

  },
  userpost: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',

  },

  dailystreak: {
    type: Number
  },

  streakslab: {
    type: String,
    enum: ['30days', '60days', '90days', '120days', '150days', '180days', '210days', '240days', '270days', '300days', '330days', '360days'],
  },

  slabAwarded: { 
    type: Number
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Activity', ActivitySchema);