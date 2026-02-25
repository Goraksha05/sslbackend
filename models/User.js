const mongoose = require('mongoose');
const { Schema } = mongoose;

const UserSchema = new Schema({
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },

    // The *referrer* (who invited me) – unchanged
    referral: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false
    },

    // ✅ NEW: Public referral code I share with others (e.g., "DU688828")
    referralId: {
        type: String,
        unique: true,
        index: true,
        sparse: true // allows existing users without referralId until backfilled
    },

    name: {
        type: String,
        required: true
    },

    username: {
        type: String,
        required: true,
        unique: true
    },

    email: {
        type: String,
        required: true,
        unique: true
    },

    phone: {
        type: String,
        required: true,
    },

    password: {
        type: String,
        required: true,
    },

    subscription_id: {
        type: String,
    },

    date: {
        type: Date,
        default: Date.now
    },

    sex: {
        type: String,
        enum: ['Male', 'Female', 'Prefered not to mention'],  // or whatever options you want
        default: 'Prefered not to mention'
    },

    // Add this section for subscriptions
    subscription: {
        plan: { type: String },                  // e.g., "Basic", "Standard", "Premium"
        paymentId: { type: String },             // Razorpay payment ID
        orderId: { type: String },               // Razorpay order ID
        active: { type: Boolean, default: false },
        startDate: { type: Date },
        expiresAt: { type: Date },
        autoRenew: { type: Boolean, default: false }
    },

    // Subscription Activation from referral registration
    activationMethod: { type: String, enum: ['paid', 'referrals', null], default: null },
    referralActivatedAt: { type: Date },
    referralTarget: { type: Number, default: 10 },

    bankDetails: {
        accountNumber: { type: String },
        ifscCode: { type: String },
        panNumber: { type: String }
    },

    totalGroceryCoupons: {
        type: Number,
        default: 0
    },

    totalShares: {
        type: Number,
        default: 0
    },

    totalReferralToken: {
        type: Number,
        default: 0
    },

    rewardedPostMilestones: {
        type: [Number],
        default: []
    },

    redeemedPostSlabs: {
        type: [Number],
        default: []
    },
    redeemedReferralSlabs: {
        type: [Number],
        default: []
    },
    redeemedStreakSlabs: {
        type: [String],
        default: []
    },

    termsAccepted: {
        type: Boolean,
        default: false
    },

    isAdmin: {
        type: Boolean,
        default: false
    },

    lastActive: {
        type: Date,
        default: Date.now,
    }

});

// ---------- Referral ID helpers ----------
function getInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    let initials = '';
    if (words.length >= 2) initials = (words[0][0] || '') + (words[1][0] || '');
    else if (words.length === 1) initials = (words[0][0] || '') + (words[0][1] || '');
    else initials = 'UU';
    initials = initials.toUpperCase().replace(/[^A-Z]/g, 'X').padEnd(2, 'X').slice(0, 2);
    return initials;
}

async function buildReferralId(name, objectId, UserModel) {
    const initials = getInitials(name);

    // Collect only digits from ObjectId (predictable & stable)
    const hex = String(objectId);
    const digitsOnly = (hex.match(/\d/g) || []).join('');

    // Prefer sliding windows of 6 digits from the digits-only sequence
    const windows = [];
    for (let i = 0; i <= Math.max(0, digitsOnly.length - 6); i++) {
        windows.push(digitsOnly.substr(i, 6));
    }
    if (windows.length === 0) {
        // Fallback if somehow not enough digits (unlikely with ObjectId)
        const asNum = parseInt(hex.slice(-6), 16);
        windows.push(String(asNum % 1000000).padStart(6, '0'));
    }

    // Try each window until uniqueness satisfied
    for (const six of [...new Set(windows)]) {
        const candidate = `${initials}${six}`;
        const exists = await UserModel.exists({ referralId: candidate });
        if (!exists) return candidate;
    }

    // Final fallback: checksum-ish base off ObjectId hex
    const big = parseInt(hex.slice(0, 12), 16);
    let salt = 0;
    while (true) {
        const six = String((big + salt) % 1000000).padStart(6, '0');
        const candidate = `${initials}${six}`;
        const exists = await UserModel.exists({ referralId: candidate });
        if (!exists) return candidate;
        salt++;
    }
}

// Auto-generate referralId on insert (or when name changes and referralId missing)
UserSchema.pre('save', async function (next) {
    try {
        if ((this.isNew || this.isModified('name')) && !this.referralId) {
            this.referralId = await buildReferralId(this.name, this._id, this.constructor);
        }
        next();
    } catch (err) {
        next(err);
    }
});

const User = mongoose.model('user', UserSchema);
module.exports = User;
module.exports.buildReferralId = buildReferralId;