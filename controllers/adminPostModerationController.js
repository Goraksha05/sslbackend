// controllers/adminPostModerationController.js
//
// Handles all admin post-moderation actions.
//
// Routes served:
//   GET    /api/admin/posts                    — paginated post list with filters
//   PATCH  /api/admin/posts/:id/moderation     — approve / reject a single post
//   DELETE /api/admin/posts/:id                — hard-delete a post
//   POST   /api/admin/posts/:id/block-user     — block the post's author
//   GET    /api/admin/posts/stats              — moderation summary counts
//
// Vulnerability / repeat-offender logic:
//   • Every PATCH that sets status="rejected" increments a counter on the user
//     (User.moderationStrikes). At threshold (default 3) the user is auto-flagged
//     with trustFlags.shadowBanned = true and a strike note is appended to
//     trustFlags — admins can then confirm a full block via POST …/block-user.
//   • POST …/block-user hard-disables the account (isAdmin stays false,
//     a new `blocked` flag is set, plus trustFlags.shadowBanned = true).
//     The user can no longer log in because the login controller must check
//     this flag (see note at bottom of file).

'use strict';

const Post = require('../models/Posts');
const User = require('../models/User');
const Moderation = require('../models/Moderation');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// ── Helpers ───────────────────────────────────────────────────────────────────

const STRIKE_THRESHOLD = 3; // auto-flag after this many rejections

/**
 * Increment moderation strike count on a user.
 * Returns the updated strike count.
 */
async function recordStrike(userId, adminId, reason) {
  const user = await User.findByIdAndUpdate(
    userId,
    {
      $inc: { 'trustFlags.moderationStrikes': 1 },
      $push: {
        'trustFlags.strikeLog': {
          at:     new Date(),
          by:     adminId,
          reason: reason || 'Post rejected by admin',
        },
      },
    },
    { new: true, select: 'trustFlags username email' }
  );

  const strikes = user?.trustFlags?.moderationStrikes ?? 0;

  // Auto-flag at threshold
  if (strikes >= STRIKE_THRESHOLD && !user?.trustFlags?.shadowBanned) {
    await User.findByIdAndUpdate(userId, {
      $set: {
        'trustFlags.shadowBanned':       true,
        'trustFlags.pendingManualReview': true,
        'trustFlags.reviewQueuedAt':      new Date(),
      },
    });
    console.warn(
      `[moderation] User ${userId} auto-flagged after ${strikes} strikes.`
    );
  }

  return strikes;
}

/**
 * Delete local media files that belong to a post (best-effort).
 */
async function deletePostMediaFiles(post) {
  if (!post.media?.length) return;
  for (const m of post.media) {
    if (!m.url) continue;
    try {
      const filename  = path.basename(m.url);
      const filePath  = path.join(
        __dirname, '..', 'uploads', 'postmedia',
        post.user_id.toString(), filename
      );
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn('[moderation] Could not delete media file:', e.message);
    }
  }
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/admin/posts
 * Query params: page, limit, status, from, to, userId
 */
exports.listPosts = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip   = (page - 1) * limit;

    const filter = {};

    // Filter by moderation status (queued / approved / rejected)
    if (req.query.status) {
      if (!['queued', 'approved', 'rejected'].includes(req.query.status)) {
        return res.status(400).json({ message: 'Invalid status filter' });
      }
      filter['moderation.status'] = req.query.status;
    }

    // Filter by author
    if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
      filter.user_id = new mongoose.Types.ObjectId(req.query.userId);
    }

    // Date range filter on post creation date
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = new Date(req.query.from);
      if (req.query.to)   filter.date.$lte = new Date(req.query.to);
    }

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate('user_id', 'name email username isAdmin trustFlags')
        .populate('moderation.reviewedBy', 'name email')
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Post.countDocuments(filter),
    ]);

    return res.json({
      posts,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    });
  } catch (err) {
    console.error('[moderation] listPosts error:', err);
    return res.status(500).json({ message: 'Failed to fetch posts' });
  }
};

/**
 * GET /api/admin/posts/stats
 * Returns counts per moderation status + auto-flagged users count.
 */
exports.getStats = async (req, res) => {
  try {
    const [queued, approved, rejected, flaggedUsers] = await Promise.all([
      Post.countDocuments({ 'moderation.status': 'queued'    }),
      Post.countDocuments({ 'moderation.status': 'approved'  }),
      Post.countDocuments({ 'moderation.status': 'rejected'  }),
      User.countDocuments({ 'trustFlags.pendingManualReview': true }),
    ]);

    return res.json({ queued, approved, rejected, flaggedUsers });
  } catch (err) {
    console.error('[moderation] getStats error:', err);
    return res.status(500).json({ message: 'Failed to fetch stats' });
  }
};

/**
 * PATCH /api/admin/posts/:id/moderation
 * Body: { status: 'approved' | 'rejected', reason?: string }
 *
 * - Sets moderation.status + stamps reviewedBy / reviewedAt.
 * - On rejection: records a strike on the author; auto-flags at threshold.
 */
exports.moderatePost = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid post ID' });
    }

    const { status, reason } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: "status must be 'approved' or 'rejected'" });
    }

    const post = await Post.findById(id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    // Update moderation fields
    post.moderation.status     = status;
    post.moderation.reviewedBy = req.user.id;
    post.moderation.reviewedAt = new Date();
    if (reason) post.moderation.rejectionReason = reason;
    await post.save();

    let strikes = null;
    let autoFlagged = false;

    if (status === 'rejected') {
      strikes     = await recordStrike(post.user_id, req.user.id, reason);
      autoFlagged = strikes >= STRIKE_THRESHOLD;
    }

    return res.json({
      message:    `Post ${status}`,
      post:       { _id: post._id, moderation: post.moderation },
      strikes,
      autoFlagged,
    });
  } catch (err) {
    console.error('[moderation] moderatePost error:', err);
    return res.status(500).json({ message: 'Failed to moderate post' });
  }
};

/**
 * DELETE /api/admin/posts/:id
 * Hard-deletes the post and its media files from disk.
 * Also records a strike on the author (deletion = implicit rejection).
 */
exports.deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid post ID' });
    }

    const post = await Post.findById(id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    await deletePostMediaFiles(post);
    await Post.findByIdAndDelete(id);

    // Record a strike for the deleted post's author
    const strikes = await recordStrike(
      post.user_id,
      req.user.id,
      'Post removed by admin'
    );

    return res.json({
      message: 'Post deleted',
      strikes,
      autoFlagged: strikes >= STRIKE_THRESHOLD,
    });
  } catch (err) {
    console.error('[moderation] deletePost error:', err);
    return res.status(500).json({ message: 'Failed to delete post' });
  }
};

/**
 * POST /api/admin/posts/:id/block-user
 * Body: { reason?: string }
 *
 * Blocks the author of the given post permanently:
 *   - Sets user.blocked = true
 *   - Sets trustFlags.shadowBanned = true
 *   - Rejects ALL remaining queued posts by that user in one bulk write
 *   - Does NOT delete the account — the record is preserved for audit
 *
 * NOTE: Your login controller (adminAuthController / authController) must check
 *   `user.blocked === true` and return 403 to prevent the user from logging in.
 *   Add this guard right after the password check:
 *
 *     if (user.blocked) {
 *       return res.status(403).json({ message: 'Your account has been suspended.' });
 *     }
 */
exports.blockUser = async (req, res) => {
  try {
    const { id } = req.params; // post ID — we derive the user from it
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid post ID' });
    }

    const post = await Post.findById(id).select('user_id');
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const { reason } = req.body;
    const userId = post.user_id;

    // Hard-block the user
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          blocked:                          true,
          blockedAt:                        new Date(),
          blockedBy:                        req.user.id,
          blockedReason:                    reason || 'Repeated policy violations',
          'trustFlags.shadowBanned':        true,
          'trustFlags.rewardsFrozen':       true,
          'trustFlags.rewardsFrozenAt':     new Date(),
          'trustFlags.referralDisabled':    true,
          'trustFlags.pendingManualReview': false, // resolved — action taken
        },
      },
      { new: true, select: 'username email blocked trustFlags' }
    );

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Bulk-reject all remaining queued posts from this user
    const { modifiedCount } = await Post.updateMany(
      { user_id: userId, 'moderation.status': 'queued' },
      {
        $set: {
          'moderation.status':           'rejected',
          'moderation.reviewedBy':       req.user.id,
          'moderation.reviewedAt':       new Date(),
          'moderation.rejectionReason':  'Account blocked by admin',
        },
      }
    );

    return res.json({
      message:            `User ${user.username || user.email} blocked`,
      queuedPostsRejected: modifiedCount,
      user: {
        _id:      userId,
        username: user.username,
        email:    user.email,
        blocked:  user.blocked,
      },
    });
  } catch (err) {
    console.error('[moderation] blockUser error:', err);
    return res.status(500).json({ message: 'Failed to block user' });
  }
};