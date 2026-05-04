/**
 * scripts/cleanupOrphanData.js
 *
 * Comprehensive orphan-data cleanup for the SoShoLife backend.
 *
 * WHAT IT CLEANS
 * ──────────────
 *  1. Profiles           — documents whose user_id no longer exists in User
 *  2. Friendships        — records where requester OR recipient no longer exists
 *  3. Notifications      — records whose user no longer exists
 *  4. Activities         — records whose user no longer exists
 *  5. RewardClaims       — records whose user no longer exists
 *  6. PushSubscriptions  — records whose user no longer exists
 *  7. Chats & Messages   — 1-to-1 chats where any member is gone; messages in those chats
 *  8. Comments           — records on posts that no longer exist
 *  9. BehaviorSignals    — records whose user no longer exists
 * 10. BehaviorVectors    — records whose user no longer exists
 * 11. DeviceGraph nodes  — 'user' nodes whose entityId is no longer a valid User
 * 12. DeviceFingerprints — removes deleted userIds from arrays; drops doc when empty
 * 13. FraudEvents        — records whose userId no longer exists
 * 14. AdminActivityLogs  — records whose adminId no longer exists
 * 15. AdminAuditLogs     — records whose adminId no longer exists
 * 16. PlatformEvents     — records with a non-null userId that no longer exists
 * 17. UserStatuses       — records whose user no longer exists
 * 18. KYC               — records whose user no longer exists
 * 19. KycAuditLogs       — records whose user OR performedBy no longer exists
 * 20. Payouts            — records whose user no longer exists
 * 21. Orphan media files — on-disk files under uploads/ not referenced by any
 *                          Message, Post, or Profile document
 *
 * USAGE
 * ─────
 * One-shot CLI (from the project root):
 *   node scripts/cleanupOrphanData.js
 *
 * Dry-run (logs what WOULD be deleted, touches nothing):
 *   $env:DRY_RUN="true"; node scripts/cleanupOrphanData.js
 *
 * Skip disk file cleanup (faster for DB-only runs):
 *   $env:SKIP_FILES="true"; node scripts/cleanupOrphanData.js
 *
 * Scheduled from index.js (runs weekly at 03:30 IST = 22:00 UTC Saturday):
 *   const cron = require('node-cron');
 *   const { runCleanup } = require('./scripts/cleanupOrphanData');
 *   cron.schedule('0 22 * * 6', () => runCleanup({ dryRun: false }));
 *
 * SAFETY NOTES
 * ────────────
 * • Always run with DRY_RUN=true first on production to preview deletions.
 * • The script never touches User documents — only orphans referencing deleted users.
 * • File cleanup is restricted to the uploads/ directory only.
 * • Every deletion is logged with a count for auditing.
 * • The script is idempotent — safe to run multiple times.
 *
 * REFACTORING NOTES (vs previous version)
 * ────────────────────────────────────────
 * • Removed duplicate logic from the now-deleted cleanupProfiles.js and
 *   cleanupUploads.js — all three scripts have been unified here.
 * • `toOids()` helper replaces the repeated inline `.map(id => new ObjectId(id))`
 *   spread pattern, cutting down boilerplate and array allocations significantly.
 * • The `$nin` queries previously spread `validUserIds` into a fresh array on
 *   every call; they now use the cached `toOids()` result.
 * • cleanOrphanFiles() adds `statusmedia` to the scan list (was missing from
 *   the old cleanupUploads.js), handles Cloudinary-hosted URLs gracefully
 *   (skips URLs that start with "http"), and prunes empty user directories.
 * • cleanChatsAndMessages() now deletes orphan messages BEFORE the chat docs
 *   to satisfy potential index constraints and improve rollback safety.
 * • All task functions follow a consistent signature: (context, models) where
 *   context = { dryRun, quiet } — no more per-call require() calls inside loops.
 */

'use strict';

require('dotenv').config({ override: true });

const fs       = require('fs');
const fsp      = require('fs/promises');
const path     = require('path');
const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a Set<string> or string[] to mongoose ObjectId[]. */
function toOids(idSet) {
  return [...idSet].map(id => new mongoose.Types.ObjectId(id));
}

/** Build a Set<string> of _id values from a lean find result. */
function toStringSet(rows) {
  return new Set(rows.map(r => String(r._id)));
}

/** Conditional log — suppressed in quiet mode. */
function log(msg, quiet) {
  if (!quiet) console.log(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual cleanup tasks
// Each returns a count (or structured object) of affected records.
// All DB work uses pre-built ObjectId arrays to avoid repeated conversions.
// ─────────────────────────────────────────────────────────────────────────────

async function cleanProfiles(ctx, { Profile, validUserIds }) {
  const orphans = await Profile.find({}, 'user_id').lean();
  const ids = orphans
    .filter(p => !p.user_id || !validUserIds.has(String(p.user_id)))
    .map(p => p._id);

  log(`[profiles] ${ids.length} orphan(s) found.`, ctx.quiet);
  if (ids.length && !ctx.dryRun) await Profile.deleteMany({ _id: { $in: ids } });
  return ids.length;
}

async function cleanFriendships(ctx, { Friendship, validUserIds }) {
  const all = await Friendship.find({}, 'requester recipient').lean();
  const ids = all
    .filter(f =>
      !validUserIds.has(String(f.requester)) ||
      !validUserIds.has(String(f.recipient))
    )
    .map(f => f._id);

  log(`[friendships] ${ids.length} orphan(s) found.`, ctx.quiet);
  if (ids.length && !ctx.dryRun) await Friendship.deleteMany({ _id: { $in: ids } });
  return ids.length;
}

async function cleanByUserField(ctx, { Model, field = 'user', label, validOids }) {
  const filter = { [field]: { $nin: validOids } };
  const count  = await Model.countDocuments(filter);
  log(`[${label}] ${count} orphan(s) found.`, ctx.quiet);
  if (count && !ctx.dryRun) await Model.deleteMany(filter);
  return count;
}

async function cleanChatsAndMessages(ctx, { Chat, Message, validUserIds }) {
  const allChats = await Chat.find({}, 'members').lean();
  const orphanChatIds = allChats
    .filter(c => (c.members || []).some(m => !validUserIds.has(String(m))))
    .map(c => c._id);

  log(`[chats] ${orphanChatIds.length} orphan chat(s) found.`, ctx.quiet);

  let messageCount = 0;
  if (orphanChatIds.length) {
    messageCount = await Message.countDocuments({ chatId: { $in: orphanChatIds } });
    log(`[messages] ${messageCount} message(s) in orphan chats.`, ctx.quiet);

    if (!ctx.dryRun) {
      // Delete messages first to avoid dangling references
      await Message.deleteMany({ chatId: { $in: orphanChatIds } });
      await Chat.deleteMany({ _id: { $in: orphanChatIds } });
    }
  }

  return { chats: orphanChatIds.length, messages: messageCount };
}

async function cleanComments(ctx, { Comment, validPostOids }) {
  const filter = { postId: { $nin: validPostOids } };
  const count  = await Comment.countDocuments(filter);
  log(`[comments] ${count} orphan(s) found (post deleted).`, ctx.quiet);
  if (count && !ctx.dryRun) await Comment.deleteMany(filter);
  return count;
}

async function cleanBehaviorData(ctx, { BehaviorSignal, BehaviorVector, validOids }) {
  const filter = { userId: { $nin: validOids } };
  const [signalCount, vectorCount] = await Promise.all([
    BehaviorSignal.countDocuments(filter),
    BehaviorVector.countDocuments(filter),
  ]);

  log(`[behaviorSignals] ${signalCount} orphan(s) found.`, ctx.quiet);
  log(`[behaviorVectors] ${vectorCount} orphan(s) found.`, ctx.quiet);

  if (!ctx.dryRun) {
    await Promise.all([
      signalCount && BehaviorSignal.deleteMany(filter),
      vectorCount && BehaviorVector.deleteMany(filter),
    ]);
  }

  return { signals: signalCount, vectors: vectorCount };
}

async function cleanDeviceGraph(ctx, { DeviceGraph, validUserIds }) {
  const filter = { entityType: 'user', entityId: { $nin: [...validUserIds] } };
  const count  = await DeviceGraph.countDocuments(filter);
  log(`[deviceGraph] ${count} stale user node(s) found.`, ctx.quiet);
  if (count && !ctx.dryRun) await DeviceGraph.deleteMany(filter);
  return count;
}

async function cleanDeviceFingerprints(ctx, { DeviceFingerprint, validOids }) {
  let pruned  = 0;
  let removed = 0;

  if (ctx.dryRun) {
    pruned  = await DeviceFingerprint.countDocuments({ userIds: { $elemMatch: { $nin: validOids } } });
    removed = await DeviceFingerprint.countDocuments({ userIds: { $size: 0 } });
  } else {
    const pullResult  = await DeviceFingerprint.updateMany(
      { userIds: { $elemMatch: { $nin: validOids } } },
      { $pull: { userIds: { $nin: validOids } } }
    );
    pruned = pullResult.modifiedCount ?? 0;

    const emptyResult = await DeviceFingerprint.deleteMany({ userIds: { $size: 0 } });
    removed = emptyResult.deletedCount ?? 0;
  }

  log(`[deviceFingerprints] ${pruned} doc(s) pruned, ${removed} empty doc(s) removed.`, ctx.quiet);
  return { pruned, removed };
}

async function cleanAdminLogs(ctx, { AdminActivityLog, AdminAuditLog, validOids }) {
  const filter = { adminId: { $nin: validOids } };
  const [activityCount, auditCount] = await Promise.all([
    AdminActivityLog.countDocuments(filter),
    AdminAuditLog.countDocuments(filter),
  ]);

  log(`[adminActivityLogs] ${activityCount} orphan(s) found.`, ctx.quiet);
  log(`[adminAuditLogs] ${auditCount} orphan(s) found.`, ctx.quiet);

  if (!ctx.dryRun) {
    await Promise.all([
      activityCount && AdminActivityLog.deleteMany(filter),
      auditCount    && AdminAuditLog.deleteMany(filter),
    ]);
  }

  return { activity: activityCount, audit: auditCount };
}

async function cleanPlatformEvents(ctx, { PlatformEvent, validOids }) {
  // Only clean events with an explicit userId — null = system-level event
  const filter = { userId: { $ne: null, $nin: validOids } };
  const count  = await PlatformEvent.countDocuments(filter);
  log(`[platformEvents] ${count} orphan(s) found.`, ctx.quiet);
  if (count && !ctx.dryRun) await PlatformEvent.deleteMany(filter);
  return count;
}

async function cleanKycData(ctx, { KYC, KycAuditLog, validOids }) {
  const kycFilter   = { user: { $nin: validOids } };
  const auditFilter = { $or: [{ user: { $nin: validOids } }, { performedBy: { $nin: validOids } }] };

  const [kycCount, auditCount] = await Promise.all([
    KYC.countDocuments(kycFilter),
    KycAuditLog.countDocuments(auditFilter),
  ]);

  log(`[kyc] ${kycCount} orphan(s) found.`, ctx.quiet);
  log(`[kycAuditLogs] ${auditCount} orphan(s) found.`, ctx.quiet);

  if (!ctx.dryRun) {
    await Promise.all([
      KYC.deleteMany(kycFilter),
      KycAuditLog.deleteMany(auditFilter),
    ]);
  }

  return { kyc: kycCount, kycAudit: auditCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan file cleanup (disk)
// Scans uploads/ subdirectories and removes files not referenced in the DB.
// Skips files whose DB URL starts with "http" (Cloudinary / external CDN).
// ─────────────────────────────────────────────────────────────────────────────

async function cleanOrphanFiles(ctx, { Message, Post, Profile, uploadsDir }) {
  const [messages, posts, profiles] = await Promise.all([
    Message.find({ $or: [{ mediaUrl: { $ne: null } }, { thumbnailUrl: { $ne: null } }] })
      .select('mediaUrl thumbnailUrl').lean(),
    Post.find({ 'media.0': { $exists: true } }).select('media').lean(),
    Profile.find({ 'profileavatar.URL': { $ne: '' } }).select('profileavatar').lean(),
  ]);

  // Collect basenames of all files referenced in the DB.
  // Skip Cloudinary / external URLs — they have no on-disk counterpart.
  const referenced = new Set();

  const addIfLocal = url => {
    if (url && !url.startsWith('http')) referenced.add(path.basename(url));
  };

  for (const msg of messages) {
    addIfLocal(msg.mediaUrl);
    addIfLocal(msg.thumbnailUrl);
  }
  for (const post of posts) {
    for (const m of post.media || []) addIfLocal(m.url);
  }
  for (const prof of profiles) {
    addIfLocal(prof.profileavatar?.URL);
  }

  const SCAN_DIRS = ['chatmedia', 'postmedia', 'chatthumbnail', 'profiles', 'statusmedia', 'kyc'];
  let deletedFiles = 0;

  for (const subDir of SCAN_DIRS) {
    const subPath = path.join(uploadsDir, subDir);
    if (!fs.existsSync(subPath)) continue;

    // Each child is typically a user-ID directory
    const children = fs.readdirSync(subPath);
    for (const child of children) {
      const childPath = path.join(subPath, child);
      const stat = fs.statSync(childPath);

      if (stat.isDirectory()) {
        // Scan files inside the user directory
        const files = fs.readdirSync(childPath);
        for (const file of files) {
          if (!referenced.has(file)) {
            const fullPath = path.join(childPath, file);
            log(`  [files] ${ctx.dryRun ? 'WOULD delete' : 'Deleted'}: ${fullPath}`, ctx.quiet);
            if (!ctx.dryRun) {
              try { fs.unlinkSync(fullPath); } catch (_) { /* best-effort */ }
            }
            deletedFiles++;
          }
        }

        // Remove the directory itself if it is now empty
        if (!ctx.dryRun && fs.existsSync(childPath) && fs.readdirSync(childPath).length === 0) {
          try { fs.rmdirSync(childPath); } catch (_) { /* best-effort */ }
        }
      } else {
        // Flat file directly inside the subDir (e.g. kyc-thumbnails)
        if (!referenced.has(child)) {
          log(`  [files] ${ctx.dryRun ? 'WOULD delete' : 'Deleted'}: ${childPath}`, ctx.quiet);
          if (!ctx.dryRun) {
            try { fs.unlinkSync(childPath); } catch (_) { /* best-effort */ }
          }
          deletedFiles++;
        }
      }
    }
  }

  log(`[files] ${deletedFiles} orphan file(s) ${ctx.dryRun ? 'found (dry run)' : 'deleted'}.`, ctx.quiet);
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
 * @param {string}  [opts.uploadsDir]       Absolute path to the uploads directory.
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

  const ctx = { dryRun, quiet };
  const tag = dryRun ? '[DRY RUN] ' : '';

  log(`\n${tag}🧹 Starting orphan data cleanup — ${new Date().toISOString()}`, quiet);
  if (dryRun) log('   DRY_RUN mode is ON — nothing will be deleted.\n', quiet);

  const t0 = Date.now();

  // ── Load models ─────────────────────────────────────────────────────────────
  // Lazy require so models are registered whether we run standalone or as a module.
  const User               = require('../models/User');
  const Profile            = require('../models/Profile');
  const Friendship         = require('../models/Friendship');
  const Notification       = require('../models/Notification');
  const Activity           = require('../models/Activity');
  const RewardClaim        = require('../models/RewardClaim');
  const PushSubscription   = require('../models/PushSubscription');
  const Chat               = require('../models/Chat');
  const Message            = require('../models/Message');
  const Comment            = require('../models/Comment');
  const BehaviorSignal     = require('../models/BehaviorSignal');
  const BehaviorVector     = require('../models/BehaviorVector');
  const DeviceGraph        = require('../models/DeviceGraph');
  const DeviceFingerprint  = require('../models/DeviceFingerprint');
  const FraudEvent         = require('../models/FraudEvent');
  const AdminActivityLog   = require('../models/AdminActivityLog');
  const AdminAuditLog      = require('../models/AdminAuditLog');
  const PlatformEvent      = require('../models/PlatformEvent');
  const UserStatus         = require('../models/UserStatus');
  const Post               = require('../models/Posts');
  const Payout             = require('../models/PayoutSchema');

  // KYC models may not exist in all environments — wrap in try/catch below.
  let KYC, KycAuditLog;
  try {
    KYC         = require('../models/KYC');
    KycAuditLog = require('../models/KycAuditLog');
  } catch (_) { /* optional models */ }

  // ── Fetch authoritative ID sets once ────────────────────────────────────────
  const [userRows, postRows] = await Promise.all([
    User.find({}, '_id').lean(),
    Post.find({}, '_id').lean(),
  ]);

  const validUserIds = toStringSet(userRows);
  const validPostIds = toStringSet(postRows);

  // Pre-build ObjectId arrays used by multiple tasks
  const validUserOids = toOids(validUserIds);
  const validPostOids = toOids(validPostIds);

  log(`   Valid users: ${validUserIds.size} | Valid posts: ${validPostIds.size}\n`, quiet);

  // ── Run tasks ────────────────────────────────────────────────────────────────
  const profilesDeleted      = await cleanProfiles(ctx, { Profile, validUserIds });
  const friendshipsDeleted   = await cleanFriendships(ctx, { Friendship, validUserIds });

  // Simple "user field must be valid" tasks share the generic helper
  const notificationsDeleted = await cleanByUserField(ctx, {
    Model: Notification, field: 'user', label: 'notifications', validOids: validUserOids,
  });
  const activitiesDeleted    = await cleanByUserField(ctx, {
    Model: Activity, field: 'user', label: 'activities', validOids: validUserOids,
  });
  const rewardClaimsDeleted  = await cleanByUserField(ctx, {
    Model: RewardClaim, field: 'user', label: 'rewardClaims', validOids: validUserOids,
  });
  const pushSubsDeleted      = await cleanByUserField(ctx, {
    Model: PushSubscription, field: 'user', label: 'pushSubscriptions', validOids: validUserOids,
  });
  const userStatusesDeleted  = await cleanByUserField(ctx, {
    Model: UserStatus, field: 'user', label: 'userStatuses', validOids: validUserOids,
  });
  const payoutsDeleted       = await cleanByUserField(ctx, {
    Model: Payout, field: 'user', label: 'payouts', validOids: validUserOids,
  });
  const fraudEventsDeleted   = await cleanByUserField(ctx, {
    Model: FraudEvent, field: 'userId', label: 'fraudEvents', validOids: validUserOids,
  });

  const { chats: chatsDeleted, messages: messagesDeleted } =
    await cleanChatsAndMessages(ctx, { Chat, Message, validUserIds });

  const commentsDeleted = await cleanComments(ctx, { Comment, validPostOids });

  const { signals: signalsDeleted, vectors: vectorsDeleted } =
    await cleanBehaviorData(ctx, { BehaviorSignal, BehaviorVector, validOids: validUserOids });

  const deviceGraphDeleted = await cleanDeviceGraph(ctx, { DeviceGraph, validUserIds });

  const { pruned: fpPruned, removed: fpRemoved } =
    await cleanDeviceFingerprints(ctx, { DeviceFingerprint, validOids: validUserOids });

  const { activity: activityLogsDeleted, audit: auditLogsDeleted } =
    await cleanAdminLogs(ctx, { AdminActivityLog, AdminAuditLog, validOids: validUserOids });

  const platformEventsDeleted =
    await cleanPlatformEvents(ctx, { PlatformEvent, validOids: validUserOids });

  let kycDeleted = 0, kycAuditDeleted = 0;
  if (KYC && KycAuditLog) {
    ({ kyc: kycDeleted, kycAudit: kycAuditDeleted } =
      await cleanKycData(ctx, { KYC, KycAuditLog, validOids: validUserOids }));
  } else {
    log('[kyc] Models not available — skipping.', quiet);
  }

  let filesDeleted = 0;
  if (!skipFiles) {
    if (fs.existsSync(uploadsDir)) {
      filesDeleted = await cleanOrphanFiles(ctx, { Message, Post, Profile, uploadsDir });
    } else {
      log('[files] uploads directory not found — skipping file cleanup.', quiet);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const summary = {
    dryRun,
    durationSeconds:           parseFloat(elapsed),
    profiles:                  profilesDeleted,
    friendships:               friendshipsDeleted,
    notifications:             notificationsDeleted,
    activities:                activitiesDeleted,
    rewardClaims:              rewardClaimsDeleted,
    pushSubscriptions:         pushSubsDeleted,
    chats:                     chatsDeleted,
    messages:                  messagesDeleted,
    comments:                  commentsDeleted,
    behaviorSignals:           signalsDeleted,
    behaviorVectors:           vectorsDeleted,
    deviceGraphNodes:          deviceGraphDeleted,
    deviceFingerprintsPruned:  fpPruned,
    deviceFingerprintsRemoved: fpRemoved,
    fraudEvents:               fraudEventsDeleted,
    adminActivityLogs:         activityLogsDeleted,
    adminAuditLogs:            auditLogsDeleted,
    platformEvents:            platformEventsDeleted,
    userStatuses:              userStatusesDeleted,
    kyc:                       kycDeleted,
    kycAuditLogs:              kycAuditDeleted,
    payouts:                   payoutsDeleted,
    orphanFiles:               filesDeleted,
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
// CLI entry point
// node scripts/cleanupOrphanData.js
// DRY_RUN=true node scripts/cleanupOrphanData.js
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const dryRun    = process.env.DRY_RUN    === 'true';
  const skipFiles = process.env.SKIP_FILES === 'true';

  console.log('⏳ Connecting to MongoDB...');
  mongoose
    .connect(process.env.MONGO_URI, { connectTimeoutMS: 10_000 })
    .then(() => {
      console.log('✅ Connected.\n');
      return runCleanup({ dryRun, skipFiles });
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