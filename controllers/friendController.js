// controllers/friendController.js
//
// All friendship business logic lives here.
// The route file (friends.js) stays thin — just validation + controller dispatch.
//
// New social features added over original:
//   • Block / unblock user
//   • Mutual friends list endpoint
//   • Friends-of-friends suggestions (2-hop graph, not just location)
//   • "People nearby" based on city/hometown (existing, improved)
//   • Sent requests (outgoing) list endpoint
//   • Friend count on profile
//   • Search friends by name
//   • Suggestion scoring: mutual friends × 3 + same city × 2 + same hometown × 1

const mongoose = require('mongoose');
const Friendship = require('../models/Friendship');
const User = require('../models/User');
const Profile = require('../models/Profile');
const Notification = require('../models/Notification');
const notifyUser = require('../utils/notifyUser');
const { sendPushToUser } = require('../utils/pushService');
const { getIO } = require('../sockets/socketManager');

// ─── Constants ────────────────────────────────────────────────────────────────
const SUGGESTION_CACHE_TTL_MS = 1000 * 60 * 30; // 30 min (was 6h — fresher results)
const MAX_SUGGESTIONS = 20;                       // was 10
const MUTUAL_FRIENDS_LIMIT = 50;

// In-memory suggestion cache: userId → { data, timestamp }
const suggestionsCache = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toStr(id) { return id?.toString?.() ?? ''; }

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function safeSocketEmit(roomId, event, payload) {
  try {
    getIO().to(toStr(roomId)).emit(event, payload);
  } catch (_) { /* socket not ready */ }
}

// ─── Suggestion scoring ───────────────────────────────────────────────────────
/**
 * Build scored friend suggestions using:
 *   - Friends-of-friends (2-hop graph)  → highest signal
 *   - Same current city                 → medium signal
 *   - Same hometown                     → low signal
 *   - Common interests / location combo → bonus
 *
 * Results are deduplicated against existing friendships and the user themselves.
 */
async function buildSuggestions(userId) {
  const userObjId = new mongoose.Types.ObjectId(userId);

  // ── Step 1: Collect all existing relationship partner IDs ─────────────────
  const existingRelationships = await Friendship.find({
    $or: [{ requester: userObjId }, { recipient: userObjId }],
    status: { $in: ['pending', 'accepted', 'blocked'] }
  }).select('requester recipient status').lean();

  const excludedIds = new Set([toStr(userObjId)]);
  const acceptedFriendIds = [];

  for (const rel of existingRelationships) {
    const rStr = toStr(rel.requester);
    const eStr = toStr(rel.recipient);
    excludedIds.add(rStr);
    excludedIds.add(eStr);
    if (rel.status === 'accepted') {
      const friendId = rStr === userId ? eStr : rStr;
      acceptedFriendIds.push(friendId);
    }
  }

  // ── Step 2: Friends-of-friends ────────────────────────────────────────────
  const fofRelationships = acceptedFriendIds.length
    ? await Friendship.find({
        $or: [
          { requester: { $in: acceptedFriendIds }, status: 'accepted' },
          { recipient: { $in: acceptedFriendIds }, status: 'accepted' }
        ]
      }).select('requester recipient').lean()
    : [];

  // Score map: candidateId → { mutualCount, mutualNames[] }
  const mutualScore = new Map();
  const mutualNames = new Map();

  for (const f of fofRelationships) {
    const r = toStr(f.requester);
    const e = toStr(f.recipient);

    // The non-friend side of each fof relationship
    const candidates = [];
    if (acceptedFriendIds.includes(r)) candidates.push(e);
    if (acceptedFriendIds.includes(e)) candidates.push(r);

    for (const cid of candidates) {
      if (excludedIds.has(cid)) continue;
      mutualScore.set(cid, (mutualScore.get(cid) ?? 0) + 1);
    }
  }

  // ── Step 3: Location-based candidates ────────────────────────────────────
  const myProfile = await Profile.findOne({ user_id: userObjId })
    .select('hometown currentcity').lean();

  const locationClauses = [];
  if (myProfile?.currentcity) locationClauses.push({ currentcity: myProfile.currentcity });
  if (myProfile?.hometown)    locationClauses.push({ hometown: myProfile.hometown });

  const locationCandidateIds = new Set();

  if (locationClauses.length) {
    const locationProfiles = await Profile.find({
      user_id: { $nin: Array.from(excludedIds).map(id => new mongoose.Types.ObjectId(id)) },
      $or: locationClauses
    }).select('user_id hometown currentcity').lean();

    for (const p of locationProfiles) {
      const cid = toStr(p.user_id);
      locationCandidateIds.add(cid);
      // Location score bonus
      let locationBonus = 0;
      if (myProfile?.currentcity && p.currentcity === myProfile.currentcity) locationBonus += 2;
      if (myProfile?.hometown    && p.hometown    === myProfile.hometown)     locationBonus += 1;
      mutualScore.set(cid, (mutualScore.get(cid) ?? 0) + locationBonus);
    }
  }

  // ── Step 4: Merge candidates and fetch profiles ───────────────────────────
  const allCandidateIds = [
    ...new Set([...mutualScore.keys(), ...locationCandidateIds])
  ].filter(id => !excludedIds.has(id));

  if (!allCandidateIds.length) return [];

  // Sort by score descending before fetching to limit DB work
  const topCandidates = allCandidateIds
    .map(id => ({ id, score: mutualScore.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map(c => c.id);

  const [profiles, users] = await Promise.all([
    Profile.find({
      user_id: { $in: topCandidates.map(id => new mongoose.Types.ObjectId(id)) }
    }).select('user_id profileavatar hometown currentcity').lean(),
    User.find({
      _id: { $in: topCandidates.map(id => new mongoose.Types.ObjectId(id)) }
    }).select('name username lastActive').lean()
  ]);

  const userMap    = Object.fromEntries(users.map(u => [toStr(u._id), u]));
  const profileMap = Object.fromEntries(profiles.map(p => [toStr(p.user_id), p]));

  // ── Step 5: Build scored result ───────────────────────────────────────────
  const results = topCandidates
    .map(cid => {
      const u = userMap[cid];
      const p = profileMap[cid];
      if (!u) return null;
      return {
        _id:               cid,
        name:              u.name,
        username:          u.username,
        profileavatar:     { URL: p?.profileavatar?.URL || '' },
        hometown:          p?.hometown    || '',
        currentcity:       p?.currentcity || '',
        mutualFriendsCount: mutualScore.get(cid) ?? 0,  // raw score used for mutual count display
        lastActive:        u.lastActive
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mutualFriendsCount - a.mutualFriendsCount);

  return results;
}

// ─── Controller methods ────────────────────────────────────────────────────────

/**
 * POST /friend-request/:recipientId
 */
exports.sendRequest = async (req, res) => {
  try {
    const { recipientId } = req.params;

    if (!isValidObjectId(recipientId))
      return res.status(400).json({ status: 'fail', message: 'Invalid recipient ID.' });

    if (req.user.id === recipientId)
      return res.status(400).json({ status: 'fail', message: "You can't send a request to yourself." });

    const recipient = await User.findById(recipientId).select('_id name').lean();
    if (!recipient)
      return res.status(404).json({ status: 'fail', message: 'User not found.' });

    const existing = await Friendship.findOne({
      $or: [
        { requester: req.user.id, recipient: recipientId },
        { requester: recipientId, recipient: req.user.id }
      ]
    }).lean();

    if (existing) {
      const msg =
        existing.status === 'accepted'  ? 'You are already friends.'         :
        existing.status === 'blocked'   ? 'Action not allowed.'              :
        existing.status === 'pending'   ? 'Friend request already exists.'   :
        'Cannot send request at this time.';
      return res.status(409).json({ status: 'fail', message: msg });
    }

    const friendship = await Friendship.create({
      requester: req.user.id,
      recipient: recipientId
    });

    // Invalidate suggestion cache for both users
    suggestionsCache.delete(req.user.id);
    suggestionsCache.delete(recipientId);

    const message = `${req.user.name} sent you a friend request 👋`;
    Promise.allSettled([
      Notification.create({
        user: recipientId, sender: req.user.id,
        type: 'friend_request', message,
        url: `/profile/${req.user.id}`
      }),
      sendPushToUser(recipientId, {
        title: 'New Friend Request 👋', message,
        url: '/friendrequest'
      })
    ]).then(() => {
      setTimeout(() => safeSocketEmit(recipientId, 'notification', {
        _id: friendship._id, type: 'friend_request',
        message, sender: req.user.id, createdAt: new Date()
      }), 800);
    });

    return res.status(201).json({
      status: 'success',
      message: 'Friend request sent.',
      data: { _id: friendship._id }
    });

  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ status: 'fail', message: 'Friend request already exists.' });
    console.error('[sendRequest]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not send friend request.' });
  }
};

/**
 * PUT /friend-request/:id/accept
 */
exports.acceptRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ status: 'fail', message: 'Invalid request ID.' });

    const friendship = await Friendship.findOneAndUpdate(
      { _id: id, recipient: req.user.id, status: 'pending' },
      { status: 'accepted' },
      { new: true }
    ).populate('requester', 'name _id');

    if (!friendship)
      return res.status(404).json({ status: 'fail', message: 'Request not found or already processed.' });

    const requesterId = toStr(friendship.requester._id);

    suggestionsCache.delete(req.user.id);
    suggestionsCache.delete(requesterId);

    const message = `${req.user.name} accepted your friend request 🎉`;
    Promise.allSettled([
      Notification.create({
        user: requesterId, sender: req.user.id,
        type: 'friend_accept', message,
        url: `/profile/${req.user.id}`
      }),
      sendPushToUser(requesterId, {
        title: 'Friend Request Accepted 🎉', message,
        url: '/allfriends'
      })
    ]).then(() => {
      safeSocketEmit(requesterId, 'notification', {
        type: 'friend_accept', message,
        sender: req.user.id, createdAt: new Date()
      });
      // Also notify accepter's own tabs so friend list updates live
      safeSocketEmit(req.user.id, 'friend_list_updated', { action: 'accepted', userId: requesterId });
    });

    return res.status(200).json({
      status: 'success',
      message: 'Friend request accepted.',
      data: friendship
    });

  } catch (err) {
    console.error('[acceptRequest]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not accept request.' });
  }
};

/**
 * PUT /friend-request/:id/decline
 */
exports.declineRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ status: 'fail', message: 'Invalid request ID.' });

    const friendship = await Friendship.findOneAndUpdate(
      { _id: id, recipient: req.user.id, status: 'pending' },
      { status: 'declined' },
      { new: true }
    ).populate('requester', 'name _id');

    if (!friendship)
      return res.status(404).json({ status: 'fail', message: 'Request not found or already processed.' });

    // Do NOT notify the requester on decline — that's better UX (less awkward)
    // Just clean up their cache
    suggestionsCache.delete(toStr(friendship.requester._id));

    return res.status(200).json({ status: 'success', message: 'Request declined.' });

  } catch (err) {
    console.error('[declineRequest]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not decline request.' });
  }
};

/**
 * DELETE /friend-request/:id/cancel
 */
exports.cancelRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ status: 'fail', message: 'Invalid request ID.' });

    const friendship = await Friendship.findOneAndDelete({
      _id: id, requester: req.user.id, status: 'pending'
    });

    if (!friendship)
      return res.status(404).json({ status: 'fail', message: 'Pending request not found.' });

    suggestionsCache.delete(req.user.id);
    suggestionsCache.delete(toStr(friendship.recipient));

    return res.status(200).json({ status: 'success', message: 'Request cancelled.' });

  } catch (err) {
    console.error('[cancelRequest]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not cancel request.' });
  }
};

/**
 * DELETE /unfriend/:friendId
 */
exports.unfriend = async (req, res) => {
  try {
    const { friendId } = req.params;
    if (!isValidObjectId(friendId))
      return res.status(400).json({ status: 'fail', message: 'Invalid friend ID.' });

    if (req.user.id === friendId)
      return res.status(400).json({ status: 'fail', message: "You can't unfriend yourself." });

    const friendship = await Friendship.findOneAndDelete({
      $or: [
        { requester: req.user.id, recipient: friendId,   status: 'accepted' },
        { requester: friendId,   recipient: req.user.id, status: 'accepted' }
      ]
    });

    if (!friendship)
      return res.status(404).json({ status: 'fail', message: 'Friendship not found.' });

    suggestionsCache.delete(req.user.id);
    suggestionsCache.delete(friendId);

    // Emit live update to both users
    safeSocketEmit(friendId, 'friend_list_updated', { action: 'removed', userId: req.user.id });
    safeSocketEmit(req.user.id, 'friend_list_updated', { action: 'removed', userId: friendId });

    return res.status(200).json({ status: 'success', message: 'Friend removed.' });

  } catch (err) {
    console.error('[unfriend]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not remove friend.' });
  }
};

/**
 * POST /block/:targetId
 * Block a user — removes any existing friendship first.
 */
exports.blockUser = async (req, res) => {
  try {
    const { targetId } = req.params;
    if (!isValidObjectId(targetId))
      return res.status(400).json({ status: 'fail', message: 'Invalid user ID.' });

    if (req.user.id === targetId)
      return res.status(400).json({ status: 'fail', message: "You can't block yourself." });

    // Remove any existing friendship record and replace with blocked
    await Friendship.deleteOne({
      $or: [
        { requester: req.user.id, recipient: targetId },
        { requester: targetId,   recipient: req.user.id }
      ]
    });

    await Friendship.create({
      requester: req.user.id,
      recipient: targetId,
      status: 'blocked'
    });

    suggestionsCache.delete(req.user.id);
    suggestionsCache.delete(targetId);

    return res.status(200).json({ status: 'success', message: 'User blocked.' });

  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ status: 'fail', message: 'Already blocked.' });
    console.error('[blockUser]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not block user.' });
  }
};

/**
 * DELETE /block/:targetId
 * Unblock a user.
 */
exports.unblockUser = async (req, res) => {
  try {
    const { targetId } = req.params;
    if (!isValidObjectId(targetId))
      return res.status(400).json({ status: 'fail', message: 'Invalid user ID.' });

    const result = await Friendship.findOneAndDelete({
      requester: req.user.id, recipient: targetId, status: 'blocked'
    });

    if (!result)
      return res.status(404).json({ status: 'fail', message: 'Block record not found.' });

    suggestionsCache.delete(req.user.id);
    return res.status(200).json({ status: 'success', message: 'User unblocked.' });

  } catch (err) {
    console.error('[unblockUser]', err.message);
    return res.status(500).json({ status: 'error', message: 'Could not unblock user.' });
  }
};

/**
 * GET /all
 * All accepted friends with profile data + online status hint.
 */
exports.getAllFriends = async (req, res) => {
  try {
    const { search = '' } = req.query;

    const friendships = await Friendship.find({
      $or: [
        { requester: req.user.id, status: 'accepted' },
        { recipient: req.user.id, status: 'accepted' }
      ]
    }).lean();

    const friendIds = friendships.map(f =>
      toStr(f.requester) === req.user.id ? f.recipient : f.requester
    );

    const [profiles, users] = await Promise.all([
      Profile.find({ user_id: { $in: friendIds } })
        .select('user_id profileavatar hometown currentcity')
        .lean(),
      User.find({ _id: { $in: friendIds } })
        .select('name username lastActive')
        .lean()
    ]);

    const userMap    = Object.fromEntries(users.map(u => [toStr(u._id), u]));
    const profileMap = Object.fromEntries(profiles.map(p => [toStr(p.user_id), p]));

    let friends = friendIds
      .map(fid => {
        const fidStr = toStr(fid);
        const u = userMap[fidStr];
        const p = profileMap[fidStr];
        if (!u) return null;
        return {
          _id:          fidStr,
          name:         u.name,
          username:     u.username,
          profileImage: p?.profileavatar?.URL || '',
          hometown:     p?.hometown    || '',
          currentcity:  p?.currentcity || '',
          lastActive:   u.lastActive
        };
      })
      .filter(Boolean);

    // Optional server-side name search
    if (search.trim()) {
      const q = search.toLowerCase();
      friends = friends.filter(f =>
        f.name.toLowerCase().includes(q) ||
        f.hometown.toLowerCase().includes(q) ||
        f.currentcity.toLowerCase().includes(q)
      );
    }

    return res.status(200).json({
      status: 'success',
      count: friends.length,
      data: friends
    });

  } catch (err) {
    console.error('[getAllFriends]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch friends.' });
  }
};

/**
 * GET /requests
 * Incoming pending requests for the authenticated user.
 */
exports.getRequests = async (req, res) => {
  try {
    const rawRequests = await Friendship.find({
      recipient: req.user.id, status: 'pending'
    })
      .populate('requester', 'name username lastActive')
      .sort({ createdAt: -1 })
      .lean();

    const requesterIds = rawRequests.map(r => r.requester?._id).filter(Boolean);
    const profiles = await Profile.find({ user_id: { $in: requesterIds } })
      .select('user_id profileavatar hometown currentcity')
      .lean();

    const profileMap = Object.fromEntries(
      profiles.map(p => [toStr(p.user_id), p])
    );

    const requests = rawRequests.map(r => {
      const req2 = r.requester;
      if (!req2) return null;
      const p = profileMap[toStr(req2._id)] || {};
      return {
        _id:       toStr(r._id),
        status:    r.status,
        createdAt: r.createdAt,
        requester: {
          _id:          toStr(req2._id),
          name:         req2.name,
          username:     req2.username,
          profileImage: p?.profileavatar?.URL || '',
          hometown:     p?.hometown    || '',
          currentcity:  p?.currentcity || '',
          lastActive:   req2.lastActive
        }
      };
    }).filter(Boolean);

    return res.status(200).json({ status: 'success', count: requests.length, data: requests });

  } catch (err) {
    console.error('[getRequests]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch requests.' });
  }
};

/**
 * GET /requests/sent
 * NEW: Outgoing pending requests the user has sent.
 */
exports.getSentRequests = async (req, res) => {
  try {
    const rawRequests = await Friendship.find({
      requester: req.user.id, status: 'pending'
    })
      .populate('recipient', 'name username')
      .sort({ createdAt: -1 })
      .lean();

    const recipientIds = rawRequests.map(r => r.recipient?._id).filter(Boolean);
    const profiles = await Profile.find({ user_id: { $in: recipientIds } })
      .select('user_id profileavatar hometown currentcity')
      .lean();

    const profileMap = Object.fromEntries(
      profiles.map(p => [toStr(p.user_id), p])
    );

    const requests = rawRequests.map(r => {
      const rec = r.recipient;
      if (!rec) return null;
      const p = profileMap[toStr(rec._id)] || {};
      return {
        _id:       toStr(r._id),
        createdAt: r.createdAt,
        recipient: {
          _id:          toStr(rec._id),
          name:         rec.name,
          username:     rec.username,
          profileImage: p?.profileavatar?.URL || '',
          hometown:     p?.hometown    || '',
          currentcity:  p?.currentcity || ''
        }
      };
    }).filter(Boolean);

    return res.status(200).json({ status: 'success', count: requests.length, data: requests });

  } catch (err) {
    console.error('[getSentRequests]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch sent requests.' });
  }
};

/**
 * GET /suggestions
 * Improved: 2-hop graph + location scoring + caching.
 */
exports.getSuggestions = async (req, res) => {
  try {
    const userId = req.user.id;
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();
    const cached = suggestionsCache.get(userId);

    let suggestions;
    if (!forceRefresh && cached && (now - cached.timestamp) < SUGGESTION_CACHE_TTL_MS) {
      suggestions = cached.data;
    } else {
      suggestions = await buildSuggestions(userId);
      suggestionsCache.set(userId, { data: suggestions, timestamp: now });
    }

    return res.status(200).json({ status: 'success', count: suggestions.length, data: suggestions });

  } catch (err) {
    console.error('[getSuggestions]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch suggestions.' });
  }
};

/**
 * GET /mutual/:targetId
 * NEW: List mutual friends between authenticated user and target.
 */
exports.getMutualFriends = async (req, res) => {
  try {
    const { targetId } = req.params;
    if (!isValidObjectId(targetId))
      return res.status(400).json({ status: 'fail', message: 'Invalid user ID.' });

    const [myFriendships, theirFriendships] = await Promise.all([
      Friendship.find({
        $or: [{ requester: req.user.id }, { recipient: req.user.id }],
        status: 'accepted'
      }).select('requester recipient').lean(),
      Friendship.find({
        $or: [{ requester: targetId }, { recipient: targetId }],
        status: 'accepted'
      }).select('requester recipient').lean()
    ]);

    const myFriendIds = new Set(myFriendships.map(f =>
      toStr(f.requester) === req.user.id ? toStr(f.recipient) : toStr(f.requester)
    ));
    const theirFriendIds = new Set(theirFriendships.map(f =>
      toStr(f.requester) === targetId ? toStr(f.recipient) : toStr(f.requester)
    ));

    const mutualIds = [...myFriendIds].filter(id => theirFriendIds.has(id));
    const mutualIdsCapped = mutualIds.slice(0, MUTUAL_FRIENDS_LIMIT);

    const [profiles, users] = await Promise.all([
      Profile.find({ user_id: { $in: mutualIdsCapped } }).select('user_id profileavatar').lean(),
      User.find({ _id: { $in: mutualIdsCapped } }).select('name username').lean()
    ]);

    const profileMap = Object.fromEntries(profiles.map(p => [toStr(p.user_id), p]));
    const mutual = users.map(u => ({
      _id:          toStr(u._id),
      name:         u.name,
      username:     u.username,
      profileImage: profileMap[toStr(u._id)]?.profileavatar?.URL || ''
    }));

    return res.status(200).json({
      status: 'success',
      count: mutualIds.length,
      data: mutual
    });

  } catch (err) {
    console.error('[getMutualFriends]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch mutual friends.' });
  }
};

/**
 * GET /status/:targetId
 * Friendship status with direction info for UI rendering.
 */
exports.getStatus = async (req, res) => {
  try {
    const { targetId } = req.params;
    if (!isValidObjectId(targetId))
      return res.status(400).json({ status: 'fail', message: 'Invalid user ID.' });

    const friendship = await Friendship.findOne({
      $or: [
        { requester: req.user.id, recipient: targetId },
        { requester: targetId,   recipient: req.user.id }
      ]
    }).lean();

    if (!friendship)
      return res.status(200).json({ status: 'success', relationship: 'none' });

    let relationship = friendship.status;
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

  } catch (err) {
    console.error('[getStatus]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to check status.' });
  }
};

/**
 * GET /count/:userId
 * NEW: Public friend count for profile display.
 */
exports.getFriendCount = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId))
      return res.status(400).json({ status: 'fail', message: 'Invalid user ID.' });

    const count = await Friendship.countDocuments({
      $or: [{ requester: userId }, { recipient: userId }],
      status: 'accepted'
    });

    return res.status(200).json({ status: 'success', count });

  } catch (err) {
    console.error('[getFriendCount]', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch count.' });
  }
};