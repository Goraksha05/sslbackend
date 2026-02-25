const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Friendship = require('../models/Friendship');
const User = require('../models/User');
const Notification = require('../models/Notification');
const fetchUser = require('../middleware/fetchuser');
const { getIO } = require('../sockets/IOsocket');
const notifyUser = require('../utils/notifyUser');
const Profile = require('../models/Profile');
const { sendPushToUser } = require('../utils/pushService');

// ─── Constants ────────────────────────────────────────────────────────────────
const SUGGESTION_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 h
const AUTO_PUSH_INTERVAL_MS   = 1000 * 60 * 60 * 6; // 6 h
const MAX_SUGGESTIONS         = 10;
const AUTO_PUSH_BATCH_SIZE    = 5;

// In-memory cache: userId → { suggestions, timestamp, sentIds: Set }
const suggestionsCache = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `id` is a syntactically valid MongoDB ObjectId.
 */
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Safely converts a string/ObjectId to string for comparison.
 */
function toStr(id) {
  return id?.toString?.() ?? '';
}

/**
 * Emit a socket notification without throwing if the socket layer isn't ready.
 */
function safeSocketEmit(roomId, event, payload) {
  try {
    const io = getIO();
    io.to(toStr(roomId)).emit(event, payload);
  } catch (_) {
    // Socket layer not yet initialised — silently ignore
  }
}

// ─── Friend-suggestion builder ────────────────────────────────────────────────

async function getSuggestionsForUser(userId) {
  const userObjId = new mongoose.Types.ObjectId(userId);

  // All friendships the user is part of
  const friendships = await Friendship.find({
    $or: [{ requester: userObjId }, { recipient: userObjId }]
  }).lean();

  // Build exclusion set and current-friend set in one pass
  const excludedIds = new Set([toStr(userObjId)]);
  const currentFriendIds = [];

  for (const f of friendships) {
    excludedIds.add(toStr(f.requester));
    excludedIds.add(toStr(f.recipient));

    if (f.status === 'accepted') {
      const friendId = toStr(f.requester) === toStr(userObjId)
        ? toStr(f.recipient)
        : toStr(f.requester);
      currentFriendIds.push(new mongoose.Types.ObjectId(friendId));
    }
  }

  // Build location filter from current user's profile
  const currentProfile = await Profile.findOne({ user_id: userObjId }).lean();
  const locationClauses = [];
  if (currentProfile?.hometown)    locationClauses.push({ hometown:    currentProfile.hometown });
  if (currentProfile?.currentcity) locationClauses.push({ currentcity: currentProfile.currentcity });

  const matchStage = {
    user_id: { $nin: Array.from(excludedIds).map(id => new mongoose.Types.ObjectId(id)) }
  };
  if (locationClauses.length) matchStage.$or = locationClauses;

  const suggestions = await Profile.aggregate([
    { $match: matchStage },
    { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },

    // Compute mutual-friends count
    {
      $lookup: {
        from: 'friendships',
        let: { sid: '$user_id' },
        pipeline: [
          { $match: { status: 'accepted' } },
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$requester', '$$sid'] },
                  { $eq: ['$recipient', '$$sid'] }
                ]
              }
            }
          },
          {
            $project: {
              otherId: {
                $cond: [{ $eq: ['$requester', '$$sid'] }, '$recipient', '$requester']
              }
            }
          }
        ],
        as: 'friendList'
      }
    },
    {
      $addFields: {
        mutualFriendsCount: {
          $size: {
            $filter: {
              input: '$friendList.otherId',
              as: 'fid',
              cond: { $in: ['$$fid', currentFriendIds] }
            }
          }
        }
      }
    },

    // Project only what the client needs
    {
      $project: {
        _id: '$user._id',
        name: '$user.name',
        profileavatar: {
          URL:  { $ifNull: ['$profileavatar.URL',  ''] },
          type: { $ifNull: ['$profileavatar.type', 'image'] }
        },
        hometown:           1,
        currentcity:        1,
        mutualFriendsCount: 1
      }
    },

    // Sort by mutual friends desc for better relevance
    { $sort:  { mutualFriendsCount: -1 } },
    { $limit: MAX_SUGGESTIONS }
  ]);

  return suggestions;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /friend-request/:recipientId
 * Send a friend request. Idempotent-safe: returns 409 for duplicates.
 */
router.post('/friend-request/:recipientId', fetchUser, async (req, res) => {
  try {
    const { recipientId } = req.params;

    // --- Validation ---
    if (!isValidObjectId(recipientId)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid recipient ID.' });
    }
    if (req.user.id === recipientId) {
      return res.status(400).json({ status: 'fail', message: "You can't send a friend request to yourself." });
    }

    // Ensure recipient exists
    const recipient = await User.findById(recipientId).select('_id name').lean();
    if (!recipient) {
      return res.status(404).json({ status: 'fail', message: 'Recipient not found.' });
    }

    // --- Duplicate check ---
    const existing = await Friendship.findOne({
      $or: [
        { requester: req.user.id, recipient: recipientId },
        { requester: recipientId, recipient: req.user.id }
      ]
    }).lean();

    if (existing) {
      const statusMsg = existing.status === 'accepted'
        ? 'You are already friends.'
        : existing.status === 'blocked'
        ? 'Action not allowed.'
        : 'A friend request already exists between you two.';
      return res.status(409).json({ status: 'fail', message: statusMsg });
    }

    // --- Create friendship ---
    const newRequest = await Friendship.create({
      requester: req.user.id,
      recipient: recipientId
    });

    // --- Notifications (fire-and-forget style, never block the response) ---
    const notifPayload = {
      user:    recipientId,
      sender:  req.user.id,
      type:    'friend_request',
      message: `${req.user.name} sent you a friend request.`,
      url:     `/profile/${req.user.id}`
    };

    // DB notification + socket (parallel, non-blocking)
    Promise.allSettled([
      Notification.create(notifPayload),
      notifyUser(recipientId, notifPayload.message, 'friend_request'),
      sendPushToUser(recipientId, {
        title:   'New Friend Request',
        message: notifPayload.message,
        url:     '/friends/requests'
      })
    ]).then(() => {
      // Delayed socket emit so recipient has time to join their room
      setTimeout(() => {
        safeSocketEmit(recipientId, 'notification', {
          type:    'friend_request',
          from:    req.user.id,
          message: notifPayload.message
        });
      }, 1000);
    }).catch(err => {
      console.error('[SEND FRIEND REQUEST] Notification side-effect error:', err.message);
    });

    return res.status(201).json({ status: 'success', message: 'Friend request sent.', data: { _id: newRequest._id } });

  } catch (error) {
    // Handle the rare race-condition duplicate-key error from the unique index
    if (error.code === 11000) {
      return res.status(409).json({ status: 'fail', message: 'Friend request already exists.' });
    }
    console.error('[SEND FRIEND REQUEST ERROR]', error.message);
    return res.status(500).json({ status: 'error', message: 'Could not send friend request.' });
  }
});


/**
 * PUT /friend-request/:id/accept
 * Accept a pending friend request addressed to the authenticated user.
 */
router.put('/friend-request/:id/accept', fetchUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid request ID.' });
    }

    const friendship = await Friendship.findOneAndUpdate(
      { _id: id, recipient: req.user.id, status: 'pending' },
      { status: 'accepted' },
      { new: true }
    ).populate('requester', 'name');

    if (!friendship) {
      return res.status(404).json({ status: 'fail', message: 'Friend request not found or already processed.' });
    }

    const requesterId = toStr(friendship.requester._id);

    Promise.allSettled([
      Notification.create({
        user:    requesterId,
        sender:  req.user.id,
        type:    'friend_accept',
        message: `${req.user.name} accepted your friend request.`,
        url:     `/profile/${req.user.id}`
      }),
      sendPushToUser(requesterId, {
        title:   'Friend Request Accepted',
        message: `${req.user.name} accepted your friend request.`,
        url:     '/friends'
      })
    ]).then(() => {
      safeSocketEmit(requesterId, 'notification', {
        type:    'friend_accept',
        from:    req.user.id,
        message: `${req.user.name} accepted your friend request.`
      });
    }).catch(err => {
      console.error('[ACCEPT FRIEND REQUEST] Notification error:', err.message);
    });

    return res.status(200).json({ status: 'success', message: 'Friend request accepted.', data: friendship });

  } catch (error) {
    console.error('[ACCEPT FRIEND REQUEST ERROR]', error.message);
    return res.status(500).json({ status: 'error', message: 'Could not accept friend request.' });
  }
});


/**
 * PUT /friend-request/:id/decline
 * Decline a pending friend request addressed to the authenticated user.
 */
router.put('/friend-request/:id/decline', fetchUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid request ID.' });
    }

    const friendship = await Friendship.findOneAndUpdate(
      { _id: id, recipient: req.user.id, status: 'pending' },
      { status: 'declined' },
      { new: true }
    ).populate('requester', 'name');

    if (!friendship) {
      return res.status(404).json({ status: 'fail', message: 'Friend request not found or already processed.' });
    }

    const requesterId = toStr(friendship.requester._id);

    Promise.allSettled([
      Notification.create({
        user:    requesterId,
        sender:  req.user.id,
        type:    'friend_decline',
        message: `${req.user.name} declined your friend request.`,
        url:     `/profile/${req.user.id}`
      }),
      sendPushToUser(requesterId, {
        title:   'Friend Request Declined',
        message: `${req.user.name} declined your friend request.`,
        url:     '/friends'
      })
    ]).then(() => {
      safeSocketEmit(requesterId, 'notification', {
        type:    'friend_decline',
        from:    req.user.id,
        message: `${req.user.name} declined your friend request.`
      });
    }).catch(err => {
      console.error('[DECLINE FRIEND REQUEST] Notification error:', err.message);
    });

    return res.status(200).json({ status: 'success', message: 'Friend request declined.' });

  } catch (error) {
    console.error('[DECLINE FRIEND REQUEST ERROR]', error.message);
    return res.status(500).json({ status: 'error', message: 'Could not decline friend request.' });
  }
});


/**
 * DELETE /unfriend/:friendId
 * Remove an existing friendship in either direction.
 */
router.delete('/unfriend/:friendId', fetchUser, async (req, res) => {
  try {
    const { friendId } = req.params;

    if (!isValidObjectId(friendId)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid friend ID.' });
    }
    if (req.user.id === friendId) {
      return res.status(400).json({ status: 'fail', message: "You can't unfriend yourself." });
    }

    const friendship = await Friendship.findOneAndDelete({
      $or: [
        { requester: req.user.id, recipient: friendId,   status: 'accepted' },
        { requester: friendId,   recipient: req.user.id, status: 'accepted' }
      ]
    });

    if (!friendship) {
      return res.status(404).json({ status: 'fail', message: 'Friendship not found.' });
    }

    return res.status(200).json({ status: 'success', message: 'Friend removed.' });

  } catch (error) {
    console.error('[UNFRIEND ERROR]', error.message);
    return res.status(500).json({ status: 'error', message: 'Could not remove friend.' });
  }
});


/**
 * GET /all
 * Return all accepted friends of the authenticated user with profile data.
 */
router.get('/all', fetchUser, async (req, res) => {
  try {
    const friendships = await Friendship.find({
      $or: [
        { requester: req.user.id, status: 'accepted' },
        { recipient: req.user.id, status: 'accepted' }
      ]
    }).lean();

    const friendIds = friendships.map(f =>
      toStr(f.requester) === req.user.id ? f.recipient : f.requester
    );

    const profiles = await Profile.find({ user_id: { $in: friendIds } })
      .populate('user_id', 'name')
      .lean();

    // SVG initials avatar (server-side fallback)
    const generateInitialsAvatar = (name) => {
      const initials = String(name || 'U')
        .split(' ')
        .map(w => w[0]?.toUpperCase() ?? '')
        .join('')
        .slice(0, 2) || 'U';

      const hash   = [...initials].reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const colors = ['#E74C3C','#2980B9','#8E44AD','#27AE60','#F39C12','#16A085'];
      const bg     = colors[hash % colors.length];
      const svg    = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${bg}"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="40" fill="white" font-family="Arial,sans-serif">${initials}</text></svg>`;
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    };

    const friends = profiles
      .filter(p => p.user_id)
      .map(p => ({
        _id:          toStr(p.user_id._id),
        name:         p.user_id.name,
        profileImage: p.profileavatar?.URL || generateInitialsAvatar(p.user_id.name),
        hometown:     p.hometown    || '',
        currentcity:  p.currentcity || ''
      }));

    return res.status(200).json({ status: 'success', count: friends.length, data: friends });

  } catch (error) {
    console.error('[GET /friends/all]', error.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch friends.' });
  }
});


/**
 * GET /requests
 * Return pending friend requests directed at the authenticated user.
 */
router.get('/requests', fetchUser, async (req, res) => {
  try {
    const rawRequests = await Friendship.find({
      recipient: req.user.id,
      status:    'pending'
    }).populate('requester', 'name').lean();

    const requesterIds = rawRequests
      .map(r => r.requester?._id)
      .filter(Boolean);

    const profiles = await Profile.find({ user_id: { $in: requesterIds } }).lean();
    const profileMap = Object.fromEntries(
      profiles.map(p => [toStr(p.user_id), p.profileavatar?.URL || ''])
    );

    const requests = rawRequests.map(r => {
      const requester = r.requester;
      return {
        _id:       toStr(r._id),
        status:    r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        requester: requester
          ? {
              _id:          toStr(requester._id),
              name:         requester.name,
              profileImage: profileMap[toStr(requester._id)] || ''
            }
          : { _id: '', name: 'Unknown User', profileImage: '' }
      };
    });

    return res.status(200).json({ status: 'success', count: requests.length, data: requests });

  } catch (error) {
    console.error('[GET FRIEND REQUESTS ERROR]', error.stack);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch friend requests.' });
  }
});


/**
 * GET /suggestions
 * Return friend suggestions for the authenticated user. Results are cached
 * per user for SUGGESTION_CACHE_TTL_MS milliseconds.
 */
router.get('/suggestions', fetchUser, async (req, res) => {
  try {
    const userId   = req.user.id;
    const cached   = suggestionsCache.get(userId);
    const now      = Date.now();
    const forceRefresh = req.query.refresh === '1';

    let suggestions;
    if (!forceRefresh && cached && (now - cached.timestamp) < SUGGESTION_CACHE_TTL_MS) {
      suggestions = cached.suggestions;
    } else {
      suggestions = await getSuggestionsForUser(userId);
      suggestionsCache.set(userId, { suggestions, timestamp: now, sentIds: new Set() });
    }

    return res.status(200).json({
      status:           'success',
      suggestionsCount: suggestions.length,
      data:             suggestions
    });
  } catch (error) {
    console.error('[GET /suggestions]', error.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch suggestions.' });
  }
});


/**
 * GET /status/:targetId
 * Return the friendship status between the authenticated user and a target.
 * Useful for the UI to know whether to show "Add Friend", "Pending", or "Friends".
 */
router.get('/status/:targetId', fetchUser, async (req, res) => {
  try {
    const { targetId } = req.params;

    if (!isValidObjectId(targetId)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid user ID.' });
    }

    const friendship = await Friendship.findOne({
      $or: [
        { requester: req.user.id, recipient: targetId },
        { requester: targetId,   recipient: req.user.id }
      ]
    }).lean();

    if (!friendship) {
      return res.status(200).json({ status: 'success', relationship: 'none' });
    }

    // If there's a pending request, clarify direction so the UI knows
    // whether to show "Cancel Request" or "Accept/Decline"
    let relationship = friendship.status; // 'pending' | 'accepted' | 'declined' | 'blocked'
    if (friendship.status === 'pending') {
      relationship = toStr(friendship.requester) === req.user.id
        ? 'pending_sent'
        : 'pending_received';
    }

    return res.status(200).json({
      status:       'success',
      relationship,
      friendshipId: toStr(friendship._id)
    });
  } catch (error) {
    console.error('[GET /status/:targetId]', error.message);
    return res.status(500).json({ status: 'error', message: 'Failed to check friendship status.' });
  }
});


/**
 * DELETE /friend-request/:id/cancel
 * Allow the requester to cancel a pending outgoing friend request.
 */
router.delete('/friend-request/:id/cancel', fetchUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid request ID.' });
    }

    const friendship = await Friendship.findOneAndDelete({
      _id:       id,
      requester: req.user.id,
      status:    'pending'
    });

    if (!friendship) {
      return res.status(404).json({ status: 'fail', message: 'Pending request not found.' });
    }

    return res.status(200).json({ status: 'success', message: 'Friend request cancelled.' });

  } catch (error) {
    console.error('[CANCEL FRIEND REQUEST ERROR]', error.message);
    return res.status(500).json({ status: 'error', message: 'Could not cancel friend request.' });
  }
});


// ─── Auto-push suggestions every 6 hours ─────────────────────────────────────
setInterval(async () => {
  try {
    const users = await User.find({}, '_id').lean();

    for (const u of users) {
      const uid  = toStr(u._id);
      const now  = Date.now();
      const cache = suggestionsCache.get(uid);

      // Only re-compute if cache is stale
      let suggestions;
      if (!cache || (now - cache.timestamp) >= SUGGESTION_CACHE_TTL_MS) {
        suggestions = await getSuggestionsForUser(uid);
        suggestionsCache.set(uid, { suggestions, timestamp: now, sentIds: cache?.sentIds ?? new Set() });
      } else {
        suggestions = cache.suggestions;
      }

      const sentIds = suggestionsCache.get(uid)?.sentIds ?? new Set();
      const fresh   = suggestions.filter(s => !sentIds.has(toStr(s._id)));

      const batch = fresh.slice(0, AUTO_PUSH_BATCH_SIZE);
      for (const sug of batch) {
        await sendPushToUser(uid, {
          title:   'New Friend Suggestion',
          message: `Meet ${sug.name} — you may know them!`,
          url:     '/friends/suggestions'
        });
        sentIds.add(toStr(sug._id));
      }

      // Update sentIds in the cache object in-place
      if (suggestionsCache.has(uid)) {
        suggestionsCache.get(uid).sentIds = sentIds;
      }
    }
  } catch (err) {
    console.error('[AUTO SUGGESTIONS PUSH]', err.message);
  }
}, AUTO_PUSH_INTERVAL_MS);


module.exports = router;