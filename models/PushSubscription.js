const mongoose = require('mongoose');

const PushSubscriptionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
        required: true
    },

    endpoint: {
        type: String,
        unique: true,
        required: true
    },

    keys: {
        p256dh: {
            type: String,
            required: true
        },
        auth: {
            type: String,
            required: true
        }
    },

    userAgent: {
        type: String
    },

    createdAt: {
        type: Date,
        default: Date.now
    },

});

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);
