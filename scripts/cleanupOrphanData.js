/**
 * scripts/cleanupOrphanData.js
 *
 * Comprehensive orphan-data cleanup for the SoShoLife backend.
 *
 * WHAT IT CLEANS
 * ──────────────
 * 1.  Profiles          — documents whose user_id no longer exists in User
 * 2.  Friendships       — records where requester OR recipient no longer exists
 * 3.  Notifications     — records whose user no longer exists
 * 4.  Activities        — records whose user no longer exists
 * 5.  RewardClaims      — records whose user no longer exists
 * 6.  PushSubscriptions — records whose user no longer exists
 * 7.  Chats             — 1-to-1 chats where any member no longer exists
 * 8.  Messages          — records in chats that no longer exist
 * 9.  Comments          — records on posts that no longer exist
 * 10. BehaviorSignals   — records whose user no longer exists
 * 11. BehaviorVectors   — records whose user no longer exists
 * 12. DeviceGraph nodes — 'user' nodes whose entityId no longer maps to a User
 * 13. DeviceFingerprints— removes deleted user IDs from the userIds array;
 *                         drops the fingerprint doc if userIds becomes empty
 * 14. FraudEvents       — records whose userId no longer exists
 * 15. AdminActivityLogs — records whose adminId no longer exists
 * 16. AdminAuditLogs    — records whose adminId no longer exists
 * 17. PlatformEvents    — records whose userId no longer exists (non-null only)
 * 18. UserStatuses      — records whose user no longer exists
 * 19. KYC (standalone)  — records whose user no longer exists
 * 20. KycAuditLogs      — records whose performedBy OR user no longer exists
 * 21. Payouts           — records whose user no longer exists
 * 22. Orphan media files — files on disk under uploads/ that are not referenced
 *                          by any Message, Post, or Profile document
 *
 * USAGE
 * ─────
 * One-shot CLI (from the project root):
 *   node scripts/cleanupOrphanData.js
 *
 * Dry-run (logs what WOULD be deleted, touches nothing):
 *   DRY_RUN=true node scripts/cleanupOrphanData.js
 *
 * Scheduled from index.js (runs weekly at 03:30 IST = 22:00 UTC Saturday):
 *   const cron = require('node-cron');
 *   const { runCleanup } = require('./scripts/cleanupOrphanData');
 *   cron.schedule('0 22 * * 6', () => runCleanup({ dryRun: false }));
 *
 * SAFETY NOTES
 * ────────────
 * • Always run with DRY_RUN=true first on production to preview deletions.
 * • The script never touches User documents — it only removes orphans that
 *   reference missing users (or missing parent records).
 * • File cleanup is restricted to the uploads/ directory only.
 * • Every deletion is logged with a count so you can audit what happened.
 * • The script is idempotent — safe to run multiple times.
 */

'use strict';

require('dotenv').config({ override: true });

const fs      = require('fs');
const path    = require('path');
const mongoose = require('mongoose');

// ── Model imports (lazy — works both as a standalone script and as a module) ──
// We import lazily inside runCleanup() so the models are registered before use
// when this script is required from index.js (where Mongoose is already set up).

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert an array of ObjectId/string values to a Set of strings. */
function toStringSet(arr) {
  return new Set(arr.map(id => String(id)));
}

/**
 * Collect all valid user IDs from the DB as a Set<string>.
 * Runs a lean projection — very cheap even with 100k+ users.
 */
async function fetchValidUserIds(User) {
  const rows = await User.find({}, '_id').lean();
  return toStringSet(rows.map(r => r._id));
}

/** Log helper — respects quiet mode for cron use. */
function log(msg, quiet = false) {
  if (!quiet) console.log(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual cleanup tasks
// ─────────────────────────────────────────────────────────────────────────────

async function cleanProfiles(validUserIds, { dryRun, quiet }) {
  const Profile = require('../models/Profile');
  const allProfiles = await Profile.find({}, 'user_id').lean();
  const orphanIds = allProfiles
    .filter(p => !p.user_id || !validUserIds.has(String(p.user_id)))
    .map(p => p._id);

  log(`[profiles] ${orphanIds.length} orphan(s) found.`, quiet);
  if (orphanIds.length && !dryRun) {
    await Profile.deleteMany({ _id: { $in: orphanIds } });
  }
  return orphanIds.length;
}

async function cleanFriendships(validUserIds, { dryRun, quiet }) {
  const Friendship = require('../models/Friendship');
  const all = await Friendship.find({}, 'requester recipient').lean();
  const orphanIds = all
    .filter(f =>
      !validUserIds.has(String(f.requester)) ||
      !validUserIds.has(String(f.recipient))
    )
    .map(f => f._id);

  log(`[friendships] ${orphanIds.length} orphan(s) found.`, quiet);
  if (orphanIds.length && !dryRun) {
    await Friendship.deleteMany({ _id: { $in: orphanIds } });
  }
  return orphanIds.length;
}

async function cleanNotifications(validUserIds, { dryRun, quiet }) {
  const Notification = require('../models/Notification');
  const count = await Notification.countDocuments({
    user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
  });
  log(`[notifications] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await Notification.deleteMany({
      user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
    });
  }
  return count;
}

async function cleanActivities(validUserIds, { dryRun, quiet }) {
  const Activity = require('../models/Activity');
  const count = await Activity.countDocuments({
    user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
  });
  log(`[activities] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await Activity.deleteMany({
      user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
    });
  }
  return count;
}

async function cleanRewardClaims(validUserIds, { dryRun, quiet }) {
  const RewardClaim = require('../models/RewardClaim');
  const count = await RewardClaim.countDocuments({
    user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
  });
  log(`[rewardClaims] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await RewardClaim.deleteMany({
      user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
    });
  }
  return count;
}

async function cleanPushSubscriptions(validUserIds, { dryRun, quiet }) {
  const PushSubscription = require('../models/PushSubscription');
  const count = await PushSubscription.countDocuments({
    user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
  });
  log(`[pushSubscriptions] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await PushSubscription.deleteMany({
      user: { $nin: [...validUserIds].map(id => new mongoose.Types.ObjectId(id)) },
    });
  }
  return count;
}

async function cleanChatsAndMessages(validUserIds, { dryRun, quiet }) {
  const Chat    = require('../models/Chat');
  const Message = require('../models/Message');

  // Orphan chats: any member is gone
  const allChats = await Chat.find({}, 'members').lean();
  const orphanChatIds = allChats
    .filter(c => (c.members || []).some(m => !validUserIds.has(String(m))))
    .map(c => c._id);

  log(`[chats] ${orphanChatIds.length} orphan chat(s) found.`, quiet);

  // Messages in orphan chats
  let messageCount = 0;
  if (orphanChatIds.length) {
    messageCount = await Message.countDocuments({ chatId: { $in: orphanChatIds } });
    log(`[messages] ${messageCount} message(s) in orphan chats.`, quiet);
    if (!dryRun) {
      await Message.deleteMany({ chatId: { $in: orphanChatIds } });
      await Chat.deleteMany({ _id: { $in: orphanChatIds } });
    }
  }

  return { chats: orphanChatIds.length, messages: messageCount };
}

async function cleanComments(validPostIds, { dryRun, quiet }) {
  const Comment = require('../models/Comment');
  const count = await Comment.countDocuments({
    postId: { $nin: [...validPostIds].map(id => new mongoose.Types.ObjectId(id)) },
  });
  log(`[comments] ${count} orphan(s) found (post deleted).`, quiet);
  if (count && !dryRun) {
    await Comment.deleteMany({
      postId: { $nin: [...validPostIds].map(id => new mongoose.Types.ObjectId(id)) },
    });
  }
  return count;
}

async function cleanBehaviorData(validUserIds, { dryRun, quiet }) {
  const BehaviorSignal = require('../models/BehaviorSignal');
  const BehaviorVector = require('../models/BehaviorVector');

  const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

  const [signalCount, vectorCount] = await Promise.all([
    BehaviorSignal.countDocuments({ userId: { $nin: validOids } }),
    BehaviorVector.countDocuments({ userId: { $nin: validOids } }),
  ]);

  log(`[behaviorSignals] ${signalCount} orphan(s) found.`, quiet);
  log(`[behaviorVectors] ${vectorCount} orphan(s) found.`, quiet);

  if (!dryRun) {
    await Promise.all([
      signalCount && BehaviorSignal.deleteMany({ userId: { $nin: validOids } }),
      vectorCount && BehaviorVector.deleteMany({ userId: { $nin: validOids } }),
    ]);
  }
  return { signals: signalCount, vectors: vectorCount };
}

async function cleanDeviceGraph(validUserIds, { dryRun, quiet }) {
  const DeviceGraph = require('../models/DeviceGraph');

  // Remove user nodes whose entityId is no longer a valid user
  const count = await DeviceGraph.countDocuments({
    entityType: 'user',
    entityId: { $nin: [...validUserIds] },
  });

  log(`[deviceGraph] ${count} stale user node(s) found.`, quiet);
  if (count && !dryRun) {
    await DeviceGraph.deleteMany({
      entityType: 'user',
      entityId: { $nin: [...validUserIds] },
    });
  }
  return count;
}

async function cleanDeviceFingerprints(validUserIds, { dryRun, quiet }) {
  const DeviceFingerprint = require('../models/DeviceFingerprint');

  const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

  // Pull deleted user IDs from the userIds arrays
  let pruned = 0;
  let removed = 0;

  if (!dryRun) {
    // Remove deleted user IDs from arrays in bulk
    const pullResult = await DeviceFingerprint.updateMany(
      { userIds: { $elemMatch: { $nin: validOids } } },
      { $pull: { userIds: { $nin: validOids } } }
    );
    pruned = pullResult.modifiedCount || 0;

    // Delete fingerprint docs that now have no users left
    const emptyResult = await DeviceFingerprint.deleteMany({ userIds: { $size: 0 } });
    removed = emptyResult.deletedCount || 0;
  } else {
    // Dry-run estimate
    pruned = await DeviceFingerprint.countDocuments({
      userIds: { $elemMatch: { $nin: validOids } },
    });
    removed = await DeviceFingerprint.countDocuments({ userIds: { $size: 0 } });
  }

  log(`[deviceFingerprints] ${pruned} doc(s) pruned, ${removed} empty doc(s) removed.`, quiet);
  return { pruned, removed };
}

async function cleanFraudEvents(validUserIds, { dryRun, quiet }) {
  const FraudEvent = require('../models/FraudEvent');
  const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

  const count = await FraudEvent.countDocuments({ userId: { $nin: validOids } });
  log(`[fraudEvents] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await FraudEvent.deleteMany({ userId: { $nin: validOids } });
  }
  return count;
}

async function cleanAdminLogs(validUserIds, { dryRun, quiet }) {
  const AdminActivityLog = require('../models/AdminActivityLog');
  const AdminAuditLog    = require('../models/AdminAuditLog');
  const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

  const [activityCount, auditCount] = await Promise.all([
    AdminActivityLog.countDocuments({ adminId: { $nin: validOids } }),
    AdminAuditLog.countDocuments({ adminId: { $nin: validOids } }),
  ]);

  log(`[adminActivityLogs] ${activityCount} orphan(s) found.`, quiet);
  log(`[adminAuditLogs] ${auditCount} orphan(s) found.`, quiet);

  if (!dryRun) {
    await Promise.all([
      activityCount && AdminActivityLog.deleteMany({ adminId: { $nin: validOids } }),
      auditCount    && AdminAuditLog.deleteMany({ adminId: { $nin: validOids } }),
    ]);
  }
  return { activity: activityCount, audit: auditCount };
}

async function cleanPlatformEvents(validUserIds, { dryRun, quiet }) {
  const PlatformEvent = require('../models/PlatformEvent');
  const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

  // Only clean events that explicitly have a userId set (null userId = system event)
  const count = await PlatformEvent.countDocuments({
    userId: { $ne: null, $nin: validOids },
  });
  log(`[platformEvents] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await PlatformEvent.deleteMany({ userId: { $ne: null, $nin: validOids } });
  }
  return count;
}

async function cleanUserStatuses(validUserIds, { dryRun, quiet }) {
  const UserStatus = require('../models/UserStatus');
  const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

  const count = await UserStatus.countDocuments({ user: { $nin: validOids } });
  log(`[userStatuses] ${count} orphan(s) found.`, quiet);
  if (count && !dryRun) {
    await UserStatus.deleteMany({ user: { $nin: validOids } });
  }
  return count;
}

async function cleanKycData(validUserIds, { dryRun, quiet }) {
  let kycCount = 0;
  let auditCount = 0;

  try {
    const KYC         = require('../models/KYC');
    const KycAuditLog = require('../models/KycAuditLog');
    const validOids   = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

    kycCount   = await KYC.countDocuments({ user: { $nin: validOids } });
    auditCount = await KycAuditLog.countDocuments({
      $or: [
        { user:        { $nin: validOids } },
        { performedBy: { $nin: validOids } },
      ],
    });

    log(`[kyc] ${kycCount} orphan(s) found.`, quiet);
    log(`[kycAuditLogs] ${auditCount} orphan(s) found.`, quiet);

    if (!dryRun) {
      await KYC.deleteMany({ user: { $nin: validOids } });
      await KycAuditLog.deleteMany({
        $or: [
          { user:        { $nin: validOids } },
          { performedBy: { $nin: validOids } },
        ],
      });
    }
  } catch (err) {
    log(`[kyc] Skipped — models not registered: ${err.message}`, quiet);
  }

  return { kyc: kycCount, kycAudit: auditCount };
}

async function cleanPayouts(validUserIds, { dryRun, quiet }) {
  let count = 0;
  try {
    const Payout    = require('../models/PayoutSchema');
    const validOids = [...validUserIds].map(id => new mongoose.Types.ObjectId(id));

    count = await Payout.countDocuments({ user: { $nin: validOids } });
    log(`[payouts] ${count} orphan(s) found.`, quiet);
    if (count && !dryRun) {
      await Payout.deleteMany({ user: { $nin: validOids } });
    }
  } catch (err) {
    log(`[payouts] Skipped — model not available: ${err.message}`, quiet);
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan file cleanup (disk)
// ─────────────────────────────────────────────────────────────────────────────

async function cleanOrphanFiles({ dryRun, quiet, uploadsDir }) {
  const Message = require('../models/Message');
  const Post    = require('../models/Posts');
  const Profile = require('../models/Profile');

  // Gather every filename referenced in the DB
  const [messages, posts, profiles] = await Promise.all([
    Message.find({ $or: [{ mediaUrl: { $ne: null } }, { thumbnailUrl: { $ne: null } }] })
      .select('mediaUrl thumbnailUrl').lean(),
    Post.find({ 'media.url': { $exists: true } }).select('media').lean(),
    Profile.find({ 'profileavatar.URL': { $ne: '' } }).select('profileavatar').lean(),
  ]);

  const referenced = new Set();

  for (const msg of messages) {
    if (msg.mediaUrl)    referenced.add(path.basename(msg.mediaUrl));
    if (msg.thumbnailUrl) referenced.add(path.basename(msg.thumbnailUrl));
  }
  for (const post of posts) {
    for (const m of post.media || []) {
      if (m.url) referenced.add(path.basename(m.url));
    }
  }
  for (const prof of profiles) {
    if (prof.profileavatar?.URL) referenced.add(path.basename(prof.profileavatar.URL));
  }

  const SCAN_DIRS = ['chatmedia', 'postmedia', 'chatthumbnail', 'profiles', 'statusmedia'];
  let deletedFiles = 0;

  for (const subDir of SCAN_DIRS) {
    const subPath = path.join(uploadsDir, subDir);
    if (!fs.existsSync(subPath)) continue;

    // Directories inside each subDir are typically user IDs
    const userDirs = fs.readdirSync(subPath);
    for (const userDir of userDirs) {
      const userPath = path.join(subPath, userDir);
      if (!fs.statSync(userPath).isDirectory()) continue;

      const files = fs.readdirSync(userPath);
      for (const file of files) {
        if (!referenced.has(file)) {
          const fullPath = path.join(userPath, file);
          if (!dryRun) {
            try { fs.unlinkSync(fullPath); } catch (_) {}
          }
          log(`  [files] ${dryRun ? 'WOULD delete' : 'Deleted'}: ${fullPath}`, quiet);
          deletedFiles++;
        }
      }

      // Remove empty user directories
      if (!dryRun && fs.existsSync(userPath) && fs.readdirSync(userPath).length === 0) {
        try { fs.rmdirSync(userPath); } catch (_) {}
      }
    }
  }

  log(`[files] ${deletedFiles} orphan file(s) ${dryRun ? 'found (dry run)' : 'deleted'}.`, quiet);
  return deletedFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all cleanup tasks.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]     Log what WOULD be deleted; touch nothing.
 * @param {boolean} [opts.quiet=false]      Suppress per-task logs (summary still prints).
 * @param {boolean} [opts.skipFiles=false]  Skip the on-disk file cleanup task.
 * @param {string}  [opts.uploadsDir]       Absolute path to uploads directory.
 *                                           Defaults to <project root>/uploads.
 * @returns {Promise<object>} Summary of deletions per category.
 */
async function runCleanup(opts = {}) {
  const {
    dryRun     = false,
    quiet      = false,
    skipFiles  = false,
    uploadsDir = path.join(__dirname, '..', 'uploads'),
  } = opts;

  const tag = dryRun ? '[DRY RUN] ' : '';
  log(`\n${tag}🧹 Starting orphan data cleanup — ${new Date().toISOString()}`, quiet);
  if (dryRun) log('   DRY_RUN mode is ON — nothing will be deleted.\n', quiet);

  const t0 = Date.now();

  // ── Load models (safe for both standalone and module usage) ─────────────────
  const User = require('../models/User');
  const Post = require('../models/Posts');

  // ── Fetch authoritative ID sets ─────────────────────────────────────────────
  const [validUserIds, validPostRows] = await Promise.all([
    fetchValidUserIds(User),
    Post.find({}, '_id').lean(),
  ]);
  const validPostIds = toStringSet(validPostRows.map(r => r._id));

  log(`   Valid users: ${validUserIds.size} | Valid posts: ${validPostIds.size}\n`, quiet);

  // ── Run tasks ────────────────────────────────────────────────────────────────
  const ctx = { dryRun, quiet };

  const profilesDeleted        = await cleanProfiles(validUserIds, ctx);
  const friendshipsDeleted     = await cleanFriendships(validUserIds, ctx);
  const notificationsDeleted   = await cleanNotifications(validUserIds, ctx);
  const activitiesDeleted      = await cleanActivities(validUserIds, ctx);
  const rewardClaimsDeleted    = await cleanRewardClaims(validUserIds, ctx);
  const pushSubsDeleted        = await cleanPushSubscriptions(validUserIds, ctx);
  const { chats: chatsDeleted, messages: messagesDeleted } = await cleanChatsAndMessages(validUserIds, ctx);
  const commentsDeleted        = await cleanComments(validPostIds, ctx);
  const { signals: signalsDeleted, vectors: vectorsDeleted } = await cleanBehaviorData(validUserIds, ctx);
  const deviceGraphDeleted     = await cleanDeviceGraph(validUserIds, ctx);
  const { pruned: fpPruned, removed: fpRemoved } = await cleanDeviceFingerprints(validUserIds, ctx);
  const fraudEventsDeleted     = await cleanFraudEvents(validUserIds, ctx);
  const { activity: activityLogsDeleted, audit: auditLogsDeleted } = await cleanAdminLogs(validUserIds, ctx);
  const platformEventsDeleted  = await cleanPlatformEvents(validUserIds, ctx);
  const userStatusesDeleted    = await cleanUserStatuses(validUserIds, ctx);
  const { kyc: kycDeleted, kycAudit: kycAuditDeleted } = await cleanKycData(validUserIds, ctx);
  const payoutsDeleted         = await cleanPayouts(validUserIds, ctx);

  let filesDeleted = 0;
  if (!skipFiles && fs.existsSync(uploadsDir)) {
    filesDeleted = await cleanOrphanFiles({ dryRun, quiet, uploadsDir });
  } else if (!skipFiles) {
    log(`[files] uploads directory not found — skipping file cleanup.`, quiet);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const summary = {
    dryRun,
    durationSeconds:     parseFloat(elapsed),
    profiles:            profilesDeleted,
    friendships:         friendshipsDeleted,
    notifications:       notificationsDeleted,
    activities:          activitiesDeleted,
    rewardClaims:        rewardClaimsDeleted,
    pushSubscriptions:   pushSubsDeleted,
    chats:               chatsDeleted,
    messages:            messagesDeleted,
    comments:            commentsDeleted,
    behaviorSignals:     signalsDeleted,
    behaviorVectors:     vectorsDeleted,
    deviceGraphNodes:    deviceGraphDeleted,
    deviceFingerprintsPruned:  fpPruned,
    deviceFingerprintsRemoved: fpRemoved,
    fraudEvents:         fraudEventsDeleted,
    adminActivityLogs:   activityLogsDeleted,
    adminAuditLogs:      auditLogsDeleted,
    platformEvents:      platformEventsDeleted,
    userStatuses:        userStatusesDeleted,
    kyc:                 kycDeleted,
    kycAuditLogs:        kycAuditDeleted,
    payouts:             payoutsDeleted,
    orphanFiles:         filesDeleted,
  };

  const totalRecords = Object.entries(summary)
    .filter(([k]) => !['dryRun', 'durationSeconds'].includes(k))
    .reduce((acc, [, v]) => acc + (typeof v === 'number' ? v : 0), 0);

  log(
    `\n${tag}✅ Cleanup complete in ${elapsed}s — ` +
    `${totalRecords} total orphan record(s)/file(s) ${dryRun ? 'found' : 'removed'}.`,
    quiet
  );
  log(JSON.stringify(summary, null, 2), quiet);

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point (node scripts/cleanupOrphanData.js)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const dryRun = process.env.DRY_RUN === 'true';

  console.log('⏳ Connecting to MongoDB...');
  mongoose
    .connect(process.env.MONGO_URI, { connectTimeoutMS: 10_000 })
    .then(() => {
      console.log('✅ Connected.\n');
      return runCleanup({ dryRun });
    })
    .then(() => {
      mongoose.connection.close();
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Cleanup failed:', err.message);
      mongoose.connection.close();
      process.exit(1);
    });
}

module.exports = { runCleanup };