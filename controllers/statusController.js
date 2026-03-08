// controllers/statusController.js
//
// Business logic for WhatsApp-style status updates.
//
// Endpoints served:
//   POST   /api/status              – post new status (text or media)
//   GET    /api/status/my           – get own statuses
//   GET    /api/status/feed         – get statuses from contacts/friends
//   GET    /api/status/:statusId    – get single status + mark as viewed
//   DELETE /api/status/:statusId    – delete own status
//   GET    /api/status/:statusId/views – list viewers (owner only)

const mongoose   = require('mongoose');
const UserStatus = require('../models/UserStatus');
const Friendship = require('../models/Friendship');
const User       = require('../models/User');
const Profile    = require('../models/Profile');
const { generatePublicUrl } = require('../middleware/upload');

// ── Helpers ───────────────────────────────────────────────────────────────────
function toStr(id) { return id?.toString?.() ?? ''; }

/**
 * Returns the set of accepted friend IDs for a given userId.
 * Used to enforce 'contacts' privacy.
 */
async function getFriendIds(userId) {
  const friendships = await Friendship.find({
    $or: [{ requester: userId }, { recipient: userId }],
    status: 'accepted'
  }).select('requester recipient').lean();

  return new Set(
    friendships.map(f =>
      toStr(f.requester) === userId ? toStr(f.recipient) : toStr(f.requester)
    )
  );
}

/**
 * Returns true if `viewerId` is allowed to see the given status document.
 */
function canView(status, viewerId, friendIds) {
  const ownerId = toStr(status.user?._id ?? status.user);
  if (ownerId === viewerId) return true; // always see own

  switch (status.privacy) {
    case 'everyone':
      return true;
    case 'contacts':
      return friendIds.has(ownerId);
    case 'except':
      return !status.privacyExclude.some(id => toStr(id) === viewerId);
    case 'only':
      return status.privacyOnly.some(id => toStr(id) === viewerId);
    default:
      return false;
  }
}

// ── POST /api/status ──────────────────────────────────────────────────────────
exports.createStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      text            = '',
      backgroundColor = '#128C7E',
      fontStyle       = 0,
      privacy         = 'contacts',
      privacyExclude  = [],
      privacyOnly     = []
    } = req.body;

    // Enforce per-user cap (deletes oldest if needed)
    await UserStatus.enforceLimit(userId);

    let type     = 'text';
    let mediaUrl = '';

    // If a file was uploaded via multer (handled in route)
    if (req.file) {
      const isVideo = req.file.mimetype.startsWith('video/');
      type     = isVideo ? 'video' : 'image';
      mediaUrl = generatePublicUrl(req, 'statusmedia', userId, req.file.filename);
    }

    if (type === 'text' && !text.trim()) {
      return res.status(400).json({ success: false, error: 'Status text cannot be empty.' });
    }

    const status = await UserStatus.create({
      user: userId,
      type,
      text:            text.trim(),
      backgroundColor,
      fontStyle:       Number(fontStyle) || 0,
      mediaUrl,
      privacy,
      privacyExclude,
      privacyOnly
    });

    // Populate user info for immediate response
    await status.populate('user', 'name username');

    return res.status(201).json({ success: true, status });
  } catch (err) {
    console.error('[createStatus]', err);
    return res.status(500).json({ success: false, error: 'Failed to create status.' });
  }
};

// ── GET /api/status/my ────────────────────────────────────────────────────────
exports.getMyStatuses = async (req, res) => {
  try {
    const userId = req.user.id;

    const statuses = await UserStatus.find({ user: userId })
      .sort({ createdAt: -1 })
      .lean();

    // Attach view count summary
    const enriched = statuses.map(s => ({
      ...s,
      viewCount: s.views?.length ?? 0
    }));

    return res.json({ success: true, statuses: enriched });
  } catch (err) {
    console.error('[getMyStatuses]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch statuses.' });
  }
};

// ── GET /api/status/feed ──────────────────────────────────────────────────────
// Returns statuses grouped by user, exactly like WhatsApp's status tab.
// Each entry: { user: { _id, name, username, profileavatar }, statuses: [...], hasUnread: bool }
exports.getStatusFeed = async (req, res) => {
  try {
    const userId    = req.user.id;
    const friendIds = await getFriendIds(userId);
    const allIds    = [...friendIds];

    if (!allIds.length) {
      return res.json({ success: true, feed: [] });
    }

    // Fetch all non-expired statuses for contacts
    const rawStatuses = await UserStatus.find({
      user:      { $in: allIds },
      expiresAt: { $gt: new Date() }
    })
      .sort({ createdAt: -1 })
      .lean();

    // Filter by privacy rules
    const visible = rawStatuses.filter(s => canView(s, userId, friendIds));

    // Group by user
    const grouped = new Map();
    for (const s of visible) {
      const uid = toStr(s.user);
      if (!grouped.has(uid)) grouped.set(uid, []);
      grouped.get(uid).push(s);
    }

    // Fetch profile info for each user who has statuses
    const uids = [...grouped.keys()];
    const [users, profiles] = await Promise.all([
      User.find({ _id: { $in: uids } }).select('name username lastActive').lean(),
      Profile.find({ user_id: { $in: uids } }).select('user_id profileavatar').lean()
    ]);

    const userMap    = Object.fromEntries(users.map(u => [toStr(u._id), u]));
    const profileMap = Object.fromEntries(profiles.map(p => [toStr(p.user_id), p]));

    const feed = uids
      .map(uid => {
        const u = userMap[uid];
        if (!u) return null;
        const p       = profileMap[uid];
        const stArr   = grouped.get(uid);
        const hasUnread = stArr.some(
          s => !s.views?.some(v => toStr(v.viewer) === userId)
        );

        // Sort: newest first, but put unseen first
        stArr.sort((a, b) => {
          const aUnseen = !a.views?.some(v => toStr(v.viewer) === userId);
          const bUnseen = !b.views?.some(v => toStr(v.viewer) === userId);
          if (aUnseen !== bUnseen) return aUnseen ? -1 : 1;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });

        return {
          user: {
            _id:           uid,
            name:          u.name,
            username:      u.username,
            profileavatar: p?.profileavatar ?? { URL: '' },
            lastActive:    u.lastActive
          },
          statuses:  stArr.map(s => ({ ...s, viewCount: s.views?.length ?? 0 })),
          hasUnread,
          latestAt:  stArr[0]?.createdAt
        };
      })
      .filter(Boolean)
      // Users with unread appear first, then by latest status time
      .sort((a, b) => {
        if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
        return new Date(b.latestAt) - new Date(a.latestAt);
      });

    return res.json({ success: true, feed });
  } catch (err) {
    console.error('[getStatusFeed]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch status feed.' });
  }
};

// ── GET /api/status/:statusId ─────────────────────────────────────────────────
// View a single status. Records the view if viewer !== owner.
exports.viewStatus = async (req, res) => {
  try {
    const { statusId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(statusId)) {
      return res.status(400).json({ success: false, error: 'Invalid status ID.' });
    }

    const status = await UserStatus.findById(statusId)
      .populate('user', 'name username');

    if (!status) {
      return res.status(404).json({ success: false, error: 'Status not found or expired.' });
    }

    const userId = req.user.id;

    // Privacy check
    const friendIds = await getFriendIds(userId);
    if (!canView(status, userId, friendIds)) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    // Record view (idempotent, won't double-count)
    if (toStr(status.user._id) !== userId) {
      await status.recordView(userId);
    }

    return res.json({
      success: true,
      status: {
        ...status.toObject(),
        viewCount: status.views.length
      }
    });
  } catch (err) {
    console.error('[viewStatus]', err);
    return res.status(500).json({ success: false, error: 'Failed to load status.' });
  }
};

// ── DELETE /api/status/:statusId ──────────────────────────────────────────────
exports.deleteStatus = async (req, res) => {
  try {
    const { statusId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(statusId)) {
      return res.status(400).json({ success: false, error: 'Invalid status ID.' });
    }

    const status = await UserStatus.findOneAndDelete({
      _id:  statusId,
      user: req.user.id
    });

    if (!status) {
      return res.status(404).json({ success: false, error: 'Status not found.' });
    }

    return res.json({ success: true, message: 'Status deleted.' });
  } catch (err) {
    console.error('[deleteStatus]', err);
    return res.status(500).json({ success: false, error: 'Failed to delete status.' });
  }
};

// ── GET /api/status/:statusId/views ──────────────────────────────────────────
// Owner-only: who has seen this status (like WhatsApp "Seen by" list)
exports.getStatusViews = async (req, res) => {
  try {
    const { statusId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(statusId)) {
      return res.status(400).json({ success: false, error: 'Invalid status ID.' });
    }

    const status = await UserStatus.findOne({
      _id:  statusId,
      user: req.user.id
    }).populate('views.viewer', 'name username');

    if (!status) {
      return res.status(404).json({ success: false, error: 'Status not found.' });
    }

    const viewerIds = status.views.map(v => v.viewer?._id).filter(Boolean);
    const profiles  = await Profile.find({ user_id: { $in: viewerIds } })
      .select('user_id profileavatar')
      .lean();
    const profileMap = Object.fromEntries(profiles.map(p => [toStr(p.user_id), p]));

    const viewers = status.views.map(v => ({
      _id:           toStr(v.viewer._id),
      name:          v.viewer.name,
      username:      v.viewer.username,
      profileavatar: profileMap[toStr(v.viewer._id)]?.profileavatar ?? { URL: '' },
      viewedAt:      v.viewedAt
    }));

    return res.json({ success: true, viewCount: viewers.length, viewers });
  } catch (err) {
    console.error('[getStatusViews]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch viewers.' });
  }
};