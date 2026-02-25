const mongoose = require('mongoose');
const { Schema } = mongoose;

const NotificationSchema = new Schema({

    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false
    },

    url: {
        type: String,
    },

    message: {
        type: String,
        required: true
    },

    type: {
        type: String,
        enum: [
            // 👥 Friends
            'friend_request',
            'friend_accept',
            'friend_decline',

            // 👤 Referrals
            'referral_signup',
            'referral_reward',
            'referral_activation',

            // 📝 Posts
            'post_reward',
            'post_deleted',   // ✅ missing, add this
            'comment',
            'like',

            // 🔥 Streaks
            'streak_reward',
            'daily_streak',
            'streak_reminder',

            // 💳 Payments
            'payment_success',
            'auto_renew',

            // ⏳ Subscription
            'expiry_reminder_7d',
            'expiry_reminder_1d',

            // 🛠️ Fallback
            'custom'
        ],
        required: true
    },

    isRead: {
        type: Boolean,
        default: false
    },

}, { timestamps: true });


module.exports = mongoose.model('Notification', NotificationSchema);