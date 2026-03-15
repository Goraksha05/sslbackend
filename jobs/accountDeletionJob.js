/**
 * jobs/accountDeletionJob.js
 *
 * Runs every hour. Finds users whose deletion grace period has expired
 * and permanently erases all their data from every collection.
 *
 * Collections scrubbed per user:
 *   • User              — the account itself
 *   • Profile           — profile data, avatar, cover, followers/following
 *   • Posts             — all posts authored by the user
 *   • Comment           — all comments made by the user
 *   • Notification      — notifications sent TO or FROM the user
 *   • Message           — messages sent by the user (soft-deleted in-place)
 *   • Chat              — chats where the user is the only participant
 *   • Friendship        — all friendship records involving the user
 *   • Activity          — activity/streak log for the user
 *   • RewardClaim       — reward claim history for the user
 *   • PushSubscription  — push subscriptions for the user
 *   • Profile.followers / Profile.following — remove user from OTHER profiles' lists
 *
 * Cloudinary assets (avatar, cover, post media) are deleted via the API.
 * Local /uploads files are deleted if they still exist (legacy).
 */

'use strict';

const cron           = require('node-cron');
const cloudinary     = require('cloudinary').v2;
const User           = require('../models/User');
const Profile        = require('../models/Profile');
const Posts          = require('../models/Posts');
const Comment        = require('../models/Comment');
const Notification   = require('../models/Notification');
const Message        = require('../models/Message');
const Chat           = require('../models/Chat');
const Friendship     = require('../models/Friendship');
const Activity       = require('../models/Activity');
const RewardClaim    = require('../models/RewardClaim');
const PushSubscription = require('../models/PushSubscription');

// ── Cloudinary folder deletion helper ─────────────────────────────────────────
async function deleteCloudinaryFolder(userId) {
  try {
    // Delete the entire Cloudinary folder for this user (profile images, posts, etc.)
    await cloudinary.api.delete_resources_by_prefix(`sosholife/profiles/${userId}/`);
    await cloudinary.api.delete_resources_by_prefix(`sosholife/posts/${userId}/`);
    console.log(`[deletionJob] ☁️  Cloudinary assets deleted for ${userId}`);
  } catch (err) {
    // Non-fatal — Cloudinary resources may already be absent
    console.warn(`[deletionJob] Cloudinary cleanup warning for ${userId}:`, err.message);
  }
}

// ── Core purge function ────────────────────────────────────────────────────────
async function purgeUser(userId) {
  const id = userId.toString();
  console.log(`[deletionJob] 🗑️  Starting purge for user ${id}`);

  // 1. Remove user from all other profiles' followers/following lists
  await Profile.updateMany(
    { $or: [{ followers: userId }, { following: userId }] },
    { $pull: { followers: userId, following: userId } }
  );

  // 2. Delete the user's own Profile
  await Profile.deleteOne({ user_id: userId });

  // 3. Get all post IDs authored by this user (needed for comment cleanup)
  const userPosts = await Posts.find({ user_id: userId }).select('_id').lean();
  const postIds   = userPosts.map(p => p._id);

  // 4. Delete comments on the user's posts AND comments made by the user
  await Comment.deleteMany({
    $or: [
      { postId: { $in: postIds } }, // comments on their posts
      { userId },                    // comments they made on others' posts
    ],
  });

  // 5. Delete all their posts
  await Posts.deleteMany({ user_id: userId });

  // 6. Notifications (to or from the user)
  await Notification.deleteMany({ $or: [{ user: userId }, { sender: userId }] });

  // 7. Messages — soft-delete (mark isDeleted, redact text) to preserve chat history shape
  await Message.updateMany(
    { sender: userId },
    {
      $set: {
        isDeleted: true,
        text:      '[This account has been deleted]',
        mediaUrl:  null,
        mediaType: null,
      },
    }
  );

  // 8. Chats where the user is the ONLY participant — hard delete
  await Chat.deleteMany({ participants: { $eq: [userId] } });
  // Otherwise just pull from participants array
  await Chat.updateMany(
    { participants: userId },
    { $pull: { participants: userId } }
  );

  // 9. Friendships (any direction)
  await Friendship.deleteMany({ $or: [{ requester: userId }, { recipient: userId }] });

  // 10. Activity logs
  await Activity.deleteMany({ user: userId });

  // 11. Reward claims
  await RewardClaim.deleteMany({ user: userId });

  // 12. Push subscriptions
  await PushSubscription.deleteMany({ user: userId });

  // 13. Cloudinary assets
  await deleteCloudinaryFolder(id);

  // 14. Finally, delete the User document itself
  await User.deleteOne({ _id: userId });

  console.log(`[deletionJob] ✅ User ${id} permanently deleted.`);
}

// ── Cron schedule: check every hour ───────────────────────────────────────────
// At the top of every hour: '0 * * * *'
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();

    // Find users whose grace period has expired
    const due = await User.find({
      'deletion.requested':   true,
      'deletion.scheduledAt': { $lte: now },
    }).select('_id name email deletion').lean();

    if (due.length === 0) {
      console.log('[deletionJob] No accounts due for deletion.');
      return;
    }

    console.log(`[deletionJob] Found ${due.length} account(s) to permanently delete.`);

    for (const user of due) {
      try {
        await purgeUser(user._id);
      } catch (err) {
        // Log but continue — don't let one failure block the rest
        console.error(`[deletionJob] ❌ Failed to purge user ${user._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[deletionJob] Job error:', err.message);
  }
});

console.log('[deletionJob] ✅ Account deletion job scheduled (runs hourly).');