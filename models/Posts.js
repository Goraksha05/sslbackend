const mongoose = require('mongoose');
const { Schema } = mongoose;

const PostSchema = new Schema({

    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true,
        index: true,
    },

    post: {
        type: String,
        required: false,
        default: ""
    },

    media: [{
        url: String,
        type: { type: String, enum: ['image', 'video', 'file'], default: 'image' }
    }],

    moderation: {
        status: {
            type: String,
            enum: ["queued", "approved", "rejected"],
            default: "queued",
        },
        labels: [{ type: String }],
        score: { type: Number, default: 0 },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }, // ✅ fixed
    },

    likes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],

    visibility: {
        type: String,
        enum: ['public', 'private', 'friends'],
        default: 'public',
        index: true,
    },


    date: {
        type: Date,
        default: Date.now
    },

});

module.exports = mongoose.model('post', PostSchema);