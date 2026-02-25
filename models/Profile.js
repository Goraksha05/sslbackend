const mongoose = require('mongoose');
const { Schema } = mongoose;

const ProfileSchema = new Schema({

    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },

    dob: {
        type: Date,
    },

    profileavatar: {
        URL: {
            type: String
        },
        type: {
            type: String,
            enum: ['image', 'video', 'file'],
            default: 'image'
        }
    },

    currentcity: {
        type: String,
    },

    hometown: {
        type: String,
    },

    sex: {
        type: String,
        enum: ['Male', 'Female', 'Prefered not to mention'],  // or whatever options you want
        default: 'Prefered not to mention'
    },

    relationship: {
        type: String,
        enum: ['Single', 'Married', 'Prefered not to mention'],  // or whatever options you want
        default: 'Prefered not to mention'
    },

    coverImage: {
        type: String
    },

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

});

const Profile = mongoose.model('profile', ProfileSchema);
module.exports = Profile