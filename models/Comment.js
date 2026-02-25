// models/CommentSchema.js
const mongoose = require('mongoose');

const CommentSchema = new mongoose.Schema({
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'posts',
    required: true
  },
  userId: {  // ✅ match your route!
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000  // ✅ handles long emoji-rich content
  },
  mentions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user'
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('comments', CommentSchema);
