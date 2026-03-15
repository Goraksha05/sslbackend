/**
 * routes/profile.js
 *
 * FIX: Avatar and cover image uploads now go to Cloudinary instead of the
 * local disk. The previous implementation stored files at:
 *   /uploads/profiles/<userId>/<filename>
 * and returned a URL like https://api.sosholife.com/uploads/...
 *
 * In production this caused ERR_CONNECTION_TIMED_OUT because:
 *   1. Many cloud hosts (Render, Railway, Heroku) have ephemeral filesystems —
 *      the /uploads folder is wiped on every deploy/restart.
 *   2. Even on a VPS, the production server must be configured to serve the
 *      /uploads folder through nginx, which was likely missing.
 *
 * Cloudinary is the correct solution — it's already configured in the app,
 * handles CDN delivery, and URLs never expire or disappear.
 *
 * Changed routes:
 *   PUT /avatar  — was: multer disk → local URL
 *                  now: multer memory → cloudinary.uploader.upload_stream → CDN URL
 *   PUT /cover   — same
 *   POST /gallery — same
 *
 * Everything else (follow, privacy settings, etc.) is unchanged.
 */

'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const multer     = require('multer');
const streamifier = require('streamifier'); // npm install streamifier
const cloudinary = require('cloudinary').v2;
const fetchUser  = require('../middleware/fetchuser');
const Profile    = require('../models/Profile');
const User       = require('../models/User');

const router = express.Router();

// ── Multer: memory storage (no disk write needed — stream straight to Cloudinary) ──
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max for profile images
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for profile photos.'));
    }
    cb(null, true);
  },
});

// ── Helper: upload a Buffer to Cloudinary and return the secure URL ────────────
function uploadToCloudinary(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id:      publicId,
        overwrite:      true,          // replace previous upload for this user
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' }, // auto-crop face-centre for avatars
          { quality: 'auto', fetch_format: 'auto' },                   // smart compression + WebP/AVIF
        ],
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url); // always https://res.cloudinary.com/...
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// ── Helper: upload a cover photo (landscape crop) ──────────────────────────────
function uploadCoverToCloudinary(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id:      publicId,
        overwrite:      true,
        transformation: [
          { width: 1200, height: 400, crop: 'fill' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile  — current user's profile (create if missing)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', fetchUser, async (req, res) => {
  try {
    let profile = await Profile.findOne({ user_id: req.user.id })
      .populate('user_id',   'name profileavatar')
      .populate('followers', 'name profileavatar')
      .populate('following', 'name profileavatar');

    if (!profile) {
      profile = await Profile.create({
        user_id:           req.user.id,
        sosholifejoinedon: Date.now(),
        sex:               'Prefered not to mention',
        relationship:      'prefered not to mention',
        profileavatar:     { URL: '', type: 'image' },
        coverImage:        '',
      });
      profile = await Profile.findOne({ user_id: req.user.id })
        .populate('user_id',   'name profileavatar')
        .populate('followers', 'name profileavatar')
        .populate('following', 'name profileavatar');
    }

    res.json(profile);
  } catch (err) {
    console.error('[GET /profile]', err.message);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/getprofile  — fetch only (no auto-create)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/getprofile', fetchUser, async (req, res) => {
  try {
    const profile = await Profile.findOne({ user_id: req.user.id })
      .populate('user_id',   'name profileavatar')
      .populate('followers', 'name profileavatar')
      .populate('following', 'name profileavatar');

    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    res.status(200).json({ status: 'success', profile });
  } catch (err) {
    console.error('[GET /getprofile]', err.message);
    res.status(500).json({ status: 'error', message: 'Server error fetching profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/profile/createprofile
// ─────────────────────────────────────────────────────────────────────────────
router.post('/createprofile', fetchUser, async (req, res) => {
  try {
    const existing = await Profile.findOne({ user_id: req.user.id });
    if (existing) return res.status(400).json({ message: 'Profile already exists' });

    const { dob, currentcity, hometown, sex, relationship } = req.body;
    let profile = await Profile.create({
      user_id: req.user.id,
      sosholifejoinedon: Date.now(),
      dob, currentcity, hometown, sex, relationship,
      profileavatar: { URL: '', type: 'image' },
      coverImage: '',
    });
    profile = await Profile.findById(profile._id).populate('user_id', 'name');
    res.status(201).json(profile);
  } catch (err) {
    console.error('[POST /createprofile]', err.message);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/updateprofile
// ─────────────────────────────────────────────────────────────────────────────
router.put('/updateprofile', fetchUser, async (req, res) => {
  try {
    const { dob, currentcity, hometown, sex, relationship } = req.body;
    let updated = await Profile.findOneAndUpdate(
      { user_id: req.user.id },
      { dob, currentcity, hometown, sex, relationship },
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ message: 'Profile not found' });
    updated = await Profile.findOne({ user_id: req.user.id }).populate('user_id', 'name');
    res.json(updated);
  } catch (err) {
    console.error('[PUT /updateprofile]', err.message);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/avatar  — FIX: Cloudinary upload (was: local disk)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/avatar', fetchUser, memUpload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    // Upload to Cloudinary — folder per user, overwrite on each upload
    const cloudinaryUrl = await uploadToCloudinary(
      req.file.buffer,
      `sosholife/profiles/${req.user.id}`,
      'avatar' // fixed public_id → always overwrites the same asset
    );

    const updated = await Profile.findOneAndUpdate(
      { user_id: req.user.id },
      { 'profileavatar.URL': cloudinaryUrl, 'profileavatar.type': 'image' },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Profile not found' });

    console.log(`[profile/avatar] ✅ Uploaded for ${req.user.id}: ${cloudinaryUrl}`);
    res.json({ success: true, updated });
  } catch (err) {
    console.error('[PUT /avatar]', err.message);
    res.status(500).json({ success: false, message: 'Avatar upload failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/cover  — FIX: Cloudinary upload (was: local disk)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/cover', fetchUser, memUpload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const cloudinaryUrl = await uploadCoverToCloudinary(
      req.file.buffer,
      `sosholife/profiles/${req.user.id}`,
      'cover'
    );

    let updated = await Profile.findOneAndUpdate(
      { user_id: req.user.id },
      { coverImage: cloudinaryUrl },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Profile not found' });

    updated = await Profile.findById(updated._id).populate('user_id', 'name');
    console.log(`[profile/cover] ✅ Uploaded for ${req.user.id}: ${cloudinaryUrl}`);
    res.json(updated);
  } catch (err) {
    console.error('[PUT /cover]', err.message);
    res.status(500).json({ message: 'Cover upload failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/profile/gallery  — FIX: Cloudinary upload (was: local disk)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/gallery', fetchUser, memUpload.array('files', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    const urls = await Promise.all(
      req.files.map((file, i) =>
        uploadToCloudinary(
          file.buffer,
          `sosholife/profiles/${req.user.id}/gallery`,
          `gallery_${Date.now()}_${i}`
        )
      )
    );

    res.json({ success: true, images: urls });
  } catch (err) {
    console.error('[POST /gallery]', err.message);
    res.status(500).json({ message: 'Gallery upload failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/profile/follow/:targetId
// ─────────────────────────────────────────────────────────────────────────────
router.put('/follow/:targetId', fetchUser, async (req, res) => {
  try {
    const userId   = req.user.id;
    const targetId = req.params.targetId;

    if (userId === targetId) return res.status(400).json({ msg: 'Cannot follow yourself' });

    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    const [currentUser, targetUser] = await Promise.all([
      Profile.findOne({ user_id: userId }),
      Profile.findOne({ user_id: targetId }),
    ]);

    if (!currentUser || !targetUser) return res.status(404).json({ msg: 'User not found' });

    const isFollowing = currentUser.following.map(String).includes(targetId);

    if (isFollowing) {
      currentUser.following.pull(targetId);
      targetUser.followers.pull(userId);
    } else {
      currentUser.following.addToSet(targetId);
      targetUser.followers.addToSet(userId);
    }

    await Promise.all([
      currentUser.save({ validateBeforeSave: false }),
      targetUser.save({ validateBeforeSave: false }),
    ]);

    res.json({
      success:     true,
      following:   currentUser.following,
      followers:   targetUser.followers,
      isFollowing: !isFollowing,
    });
  } catch (err) {
    console.error('[PUT /follow]', err.message);
    res.status(500).json({ message: 'Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/followstatus
// ─────────────────────────────────────────────────────────────────────────────
router.get('/followstatus', fetchUser, async (req, res) => {
  const targetId     = req.query.userId;
  const currentUserId = req.user.id;
  try {
    const currentUser = await User.findById(currentUserId);
    const isFollowing = currentUser.following?.includes(targetId);
    res.json({ isFollowing });
  } catch (err) {
    console.error('[GET /followstatus]', err.message);
    res.status(500).json({ message: 'Failed to check follow status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Privacy helpers + routes (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function applyPrivacy(profile, viewerId) {
  const prefs = profile.settings?.privacy || {};
  return {
    _id:      profile._id,
    user_id: {
      _id:           profile.user_id?._id || profile._id,
      name:          prefs.allowSearchByName || viewerId === profile.user_id?._id.toString() ? profile.user_id?.name      : undefined,
      username:      prefs.allowSearchByName || viewerId === profile.user_id?._id.toString() ? profile.user_id?.username  : undefined,
      email:         prefs.showEmail         ? profile.user_id?.email         : undefined,
      profileavatar: profile.user_id?.profileavatar || { URL: '', type: 'image' },
      lastActive:    profile.user_id?.lastActive || null,
    },
    profileavatar:   profile.profileavatar,
    coverImage:      profile.coverImage,
    currentcity:     prefs.showLocation ? profile.currentcity : undefined,
    hometown:        prefs.showLocation ? profile.hometown    : undefined,
    sex:             profile.sex,
    relationship:    profile.relationship,
    followers:       profile.followers,
    following:       profile.following,
    dob:             prefs.showDOB ? profile.dob : undefined,
    sosholifejoinedon: profile.sosholifejoinedon,
  };
}

router.get('/:id', fetchUser, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }
    const profile = await Profile.findOne({ user_id: targetId })
      .populate('user_id',   'name username email lastActive profileavatar')
      .populate('followers', 'name profileavatar')
      .populate('following', 'name profileavatar');

    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    res.status(200).json({ status: 'success', profile: applyPrivacy(profile, req.user.id) });
  } catch (err) {
    console.error('[GET /:id]', err.message);
    res.status(500).json({ message: 'Server error fetching profile' });
  }
});

router.get('/privacy-settings', fetchUser, async (req, res) => {
  const profile = await Profile.findOne({ user_id: req.user.id });
  if (!profile) return res.status(404).json({ message: 'Profile not found' });
  res.json(profile.settings?.privacy || {});
});

router.put('/privacy-settings', fetchUser, async (req, res) => {
  const profile = await Profile.findOneAndUpdate(
    { user_id: req.user.id },
    { 'settings.privacy': req.body },
    { new: true }
  );
  res.json(profile.settings.privacy);
});

router.get('/notification-settings', fetchUser, async (req, res) => {
  try {
    const profile = await Profile.findOne({ user_id: req.user.id }).select('settings.notifications');
    if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
    res.status(200).json({ success: true, notifications: profile.settings?.notifications || {} });
  } catch (err) {
    console.error('[GET /notification-settings]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/notification-settings', fetchUser, async (req, res) => {
  try {
    const profile = await Profile.findOneAndUpdate(
      { user_id: req.user.id },
      { $set: { 'settings.notifications': req.body } },
      { new: true, projection: { 'settings.notifications': 1 } }
    );
    if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
    res.status(200).json({ success: true, notifications: profile.settings.notifications });
  } catch (err) {
    console.error('[PUT /notification-settings]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;