const express = require('express');
const mongoose = require('mongoose');
const fetchUser = require('../middleware/fetchuser');
const Profile = require('../models/Profile');
const User = require('../models/User');
const { uploadProfile, uploadMultiple } = require('../middleware/upload');
//const { uploadProfile } = require('../middleware/upload');
const router = express.Router();

// Determine base URL
const getBaseUrl = (req) => {
    return process.env.NODE_ENV === 'production'
        ? 'https://api.sosholife.com'
        : `${req.protocol}://${req.get('host')}`;
};

// GET current user's profile or create if missing
router.get('/', fetchUser, async (req, res) => {
    try {
        let profile = await Profile.findOne({ user_id: req.user.id })
            .populate('user_id', 'name profileavatar')
            .populate('followers', 'name profileavatar')
            .populate('following', 'name profileavatar');

        if (!profile) {
            profile = new Profile({
                user_id: req.user.id,
                sosholifejoinedon: Date.now(),
                dob: '',
                currentcity: '',
                hometown: '',
                sex: 'Prefered not to mention',
                relationship: 'prefered not to mention',
                profileavatar: { URL: '', type: 'image' },
                coverImage: ''
            });
            await profile.save();
            profile = await Profile.findOne({ user_id: req.user.id })
                .populate('user_id', 'name profileavatar')
                .populate('followers', 'name profileavatar')
                .populate('following', 'name profileavatar');
        }

        res.json(profile);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// GET current user's profile (only fetch, not create)
router.get('/getprofile', fetchUser, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized: Invalid token' });
        }

        const profile = await Profile.findOne({ user_id: userId })
            .populate('user_id', 'name profileavatar')
            .populate('followers', 'name profileavatar')
            .populate('following', 'name profileavatar');

        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        res.status(200).json({ status: 'success', profile });
    } catch (err) {
        console.error(`[GET /getprofile] ❌`, err);
        res.status(500).json({ status: 'error', message: 'Server error fetching profile' });
    }
});

// Create new profile
router.post('/createprofile', fetchUser, async (req, res) => {
    try {
        const existing = await Profile.findOne({ user_id: req.user.id });
        if (existing) {
            return res.status(400).json({ message: 'Profile already exists' });
        }

        const { dob, currentcity, hometown, sex, relationship } = req.body;
        let profile = new Profile({
            user_id: req.user.id,
            sosholifejoinedon: Date.now(),
            dob,
            currentcity,
            hometown,
            sex,
            relationship,
            profileavatar: { URL: '', type: 'image' },
            coverImage: ''
        });
        await profile.save();
        profile = await Profile.findById(profile._id).populate('user_id', 'name');
        res.status(201).json(profile);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Update profile fields
router.put('/updateprofile', fetchUser, async (req, res) => {
    try {
        const { dob, currentcity, hometown, sex, relationship } = req.body;
        let updated = await Profile.findOneAndUpdate(
            { user_id: req.user.id },
            { dob, currentcity, hometown, sex, relationship },
            { new: true, runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        updated = await Profile.findOne({ user_id: req.user.id }).populate('user_id', 'name');
        res.json(updated);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Upload avatar
router.put('/avatar', fetchUser, uploadProfile, async (req, res) => {
    // console.log("Received file:", req.file);
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const url = `${getBaseUrl(req)}/uploads/profiles/${req.user.id}/${req.file.filename}`;

        const updated = await Profile.findOneAndUpdate(
            { user_id: req.user.id },
            { 'profileavatar.URL': url, 'profileavatar.type': 'image' },
            { new: true }
        );

        if (!updated) return res.status(404).json({ message: 'Profile not found' });

        res.json({ success: true, updated });
    } catch (err) {
        console.error('❌ Avatar upload failed:', err);
        res.status(500).json({ success: false, message: 'Avatar upload failed' });
    }
});

// Upload gallery images
router.post('/gallery', fetchUser, uploadMultiple('files', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        const urls = req.files.map(file =>
            `${getBaseUrl(req)}/uploads/profiles/${req.user.id}/${file.filename}`
        );

        res.json({ success: true, images: urls });
    } catch (err) {
        console.error('Gallery upload failed:', err);
        res.status(500).json({ message: 'Gallery upload failed' });
    }
});

// Upload cover image
router.put('/cover', fetchUser, uploadProfile, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const url = `${getBaseUrl(req)}/uploads/profiles/${req.user.id}/${req.file.filename}`;

        let updated = await Profile.findOneAndUpdate(
            { user_id: req.user.id },
            { coverImage: url },
            { new: true }
        );

        if (!updated) return res.status(404).json({ message: 'Profile not found' });

        updated = await Profile.findById(updated._id).populate('user_id', 'name');
        res.json(updated);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Cover upload failed');
    }
});

// Follow or unfollow a user
router.put('/follow/:targetId', fetchUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const targetId = req.params.targetId;

        if (userId === targetId) return res.status(400).json({ msg: "Cannot follow yourself" });

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(targetId)) {
            return res.status(400).json({ msg: "Invalid user ID" });
        }

        const currentUser = await Profile.findOne({ user_id: userId });
        const targetUser = await Profile.findOne({ user_id: targetId });

        if (!currentUser || !targetUser) return res.status(404).json({ msg: "User not found" });

        // Convert IDs to string before checking
        const isFollowing = currentUser.following.map(String).includes(targetId);

        if (isFollowing) {
            currentUser.following.pull(targetId);
            targetUser.followers.pull(userId);
        } else {
            currentUser.following.addToSet(targetId);
            targetUser.followers.addToSet(userId);
        }

        // await Promise.all([currentUser.save(), targetUser.save()]);
        await currentUser.save({ validateBeforeSave: false });
        await targetUser.save({ validateBeforeSave: false });;

        res.json({
            success: true,
            following: currentUser.following,
            followers: targetUser.followers,
            isFollowing: !isFollowing
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Check follow status
router.get('/followstatus', fetchUser, async (req, res) => {
    const targetId = req.query.userId;
    const currentUserId = req.user.id;

    try {
        const currentUser = await User.findById(currentUserId);
        const isFollowing = currentUser.following?.includes(targetId);
        res.json({ isFollowing });
    } catch (err) {
        console.error('[GET /followstatus]', err);
        res.status(500).json({ message: 'Failed to check follow status' });
    }
});

// ✅ Helper: enforce privacy settings
function applyPrivacy(profile, viewerId) {
    const prefs = profile.settings?.privacy || {};

    const safeProfile = {
        _id: profile._id,
        user_id: {
            _id: profile.user_id?._id || profile._id,
            name:
                prefs.allowSearchByName || viewerId === profile.user_id?._id.toString()
                    ? profile.user_id?.name
                    : undefined,
            username:
                prefs.allowSearchByName || viewerId === profile.user_id?._id.toString()
                    ? profile.user_id?.username
                    : undefined,
            email: prefs.showEmail ? profile.user_id?.email : undefined,
            profileavatar: profile.user_id?.profileavatar || { URL: '', type: 'image' },
            lastActive: profile.user_id?.lastActive || null,
        },
        profileavatar: profile.profileavatar,
        coverImage: profile.coverImage,
        currentcity: prefs.showLocation ? profile.currentcity : undefined,
        hometown: prefs.showLocation ? profile.hometown : undefined,
        sex: profile.sex,
        relationship: profile.relationship,
        followers: profile.followers,
        following: profile.following,
        dob: prefs.showDOB ? profile.dob : undefined,
        sosholifejoinedon: profile.sosholifejoinedon,
    };

    return safeProfile;
}
// ✅ Get a profile by user ID (for search results / modal view)
router.get('/:id', fetchUser, async (req, res) => {
    try {
        const targetId = req.params.id;

        if (!mongoose.Types.ObjectId.isValid(targetId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const profile = await Profile.findOne({ user_id: targetId })
            .populate('user_id', 'name username email lastActive profileavatar')
            .populate('followers', 'name profileavatar')
            .populate('following', 'name profileavatar');

        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        // ✅ Apply privacy rules
        const safeProfile = applyPrivacy(profile, req.user.id);

        res.status(200).json({ status: 'success', profile: safeProfile });
    } catch (err) {
        console.error('[GET /:id] ❌', err);
        res.status(500).json({ message: 'Server error fetching profile' });
    }
});

// GET current user's privacy settings
router.get('/privacy-settings', fetchUser, async (req, res) => {
    const profile = await Profile.findOne({ user_id: req.user.id });
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    res.json(profile.settings?.privacy || {});
});

// UPDATE privacy settings
router.put('/privacy-settings', fetchUser, async (req, res) => {
    const profile = await Profile.findOneAndUpdate(
        { user_id: req.user.id },
        { 'settings.privacy': req.body },
        { new: true }
    );
    res.json(profile.settings.privacy);
});

// ✅ Get current user's notification settings
router.get("/notification-settings", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;

    const profile = await Profile.findOne({ user_id: userId }).select("settings.notifications");
    if (!profile) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    return res.status(200).json({
      success: true,
      notifications: profile.settings?.notifications || {}
    });
  } catch (err) {
    console.error("[GET /notification-settings] ❌", err.message);
    return res.status(500).json({ success: false, message: "Server error fetching notification settings" });
  }
});

// ✅ Update notification settings
router.put("/notification-settings", fetchUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = req.body;

    const profile = await Profile.findOneAndUpdate(
      { user_id: userId },
      { $set: { "settings.notifications": updates } },
      { new: true, projection: { "settings.notifications": 1 } }
    );

    if (!profile) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    return res.status(200).json({
      success: true,
      notifications: profile.settings.notifications
    });
  } catch (err) {
    console.error("[PUT /notification-settings] ❌", err.message);
    return res.status(500).json({ success: false, message: "Server error updating notification settings" });
  }
});

module.exports = router;