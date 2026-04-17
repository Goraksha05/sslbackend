/**
 * services/rewardNotificationService.js
 *
 * USAGE
 * ─────
 *   const rn = require('./rewardNotificationService');
 *
 *   // From RewardEngine / activity routes (after successful claim):
 *   await rn.notifyRewardClaimed({ userId, userName, rewardType, milestone, planKey, amountINR, claimId });
 *
 *   // From financeAndPayoutController (after status change):
 *   await rn.notifyPayoutStatusChanged({ payoutId, userId, userName, oldStatus, newStatus, amountINR, reason });
 *
 *   // From redeemGrocery route (after submission):
 *   await rn.notifyGroceryRedemptionSubmitted({ userId, userName, amountINR, payoutId });
 *
 *   // From bulkProcess (after batch completes):
 *   await rn.notifyBulkPayoutComplete({ adminId, processed, skipped, failed, totalINRDispatched });
 */

'use strict';

const User          = require('../models/User');
const Notification  = require('../models/Notification');
const AdminRole     = require('../models/AdminRole');
const { getIO }         = require('../sockets/socketManager');
const { sendPushToUser } = require('../utils/pushService');

// ── Configuration ─────────────────────────────────────────────────────────────
const HIGH_VALUE_INR_THRESHOLD = 5000; // Claims above this get an extra flag to admins

// Socket room names — must match IOsocket.js
const ADMIN_ROOM = 'admin_room';

// ── Emoji / label maps ────────────────────────────────────────────────────────
const TYPE_EMOJI = {
  post:           '📝',
  referral:       '🤝',
  streak:         '🔥',
  grocery_redeem: '🛒',
};

const STATUS_EMOJI = {
  pending:    '⏳',
  processing: '⚙️',
  paid:       '✅',
  failed:     '❌',
  on_hold:    '🔒',
};

function fmtINR(n) {
  if (typeof n !== 'number') return '₹—';
  return `₹${n.toLocaleString('en-IN')}`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// ── Fetch all admins who can manage payouts ────────────────────────────────────
async function fetchPayoutAdmins() {
  try {
    const rolesWithPerm = await AdminRole.find({
      permissions: 'manage_payouts',
    }).select('_id').lean();

    const roleIds = rolesWithPerm.map(r => r._id);

    return User.find({
      $or: [
        { role: 'super_admin' },
        {
          role: 'admin',
          $or: [
            { adminPermissions: 'manage_payouts' },
            { adminRole: { $in: roleIds } },
          ],
        },
      ],
    }).select('_id name email role').lean();
  } catch (err) {
    console.error('[rewardNotify] fetchPayoutAdmins failed:', err.message);
    return [];
  }
}

// ── Core dispatcher ───────────────────────────────────────────────────────────
/**
 * Fire a notification to a single user across all three channels.
 * All errors are caught per-channel so one failure never blocks the others.
 *
 * @param {string|ObjectId} userId
 * @param {string}          message      Human-readable text
 * @param {string}          type         Notification schema enum value
 * @param {string}          [url]        Deep-link
 * @param {object}          [pushPayload] Override for web-push
 * @param {object}          [socketPayload] Extra data for socket event
 */
async function dispatchToUser(userId, message, type, url = '/', pushPayload = null, socketPayload = {}) {
  const uid = String(userId);

  // 1 — DB
  let notif = null;
  try {
    notif = await Notification.create({
      user:    userId,
      message,
      type,
      url,
    });
  } catch (err) {
    console.error(`[rewardNotify] DB write failed for ${uid}:`, err.message);
  }

  // 2 — Socket
  try {
    const io = getIO();
    io.to(uid).emit('notification', {
      _id:       notif?._id,
      type,
      message,
      url,
      ...socketPayload,
      createdAt: new Date(),
    });
  } catch (err) {
    console.debug(`[rewardNotify] Socket skipped for ${uid}: ${err.message}`);
  }

  // 3 — Push
  try {
    await sendPushToUser(uid, pushPayload ?? {
      title:   'SoShoLife Rewards',
      message,
      url,
    });
  } catch (err) {
    console.debug(`[rewardNotify] Push skipped for ${uid}: ${err.message}`);
  }

  return notif;
}

/**
 * Broadcast a notification to all payout-admin users simultaneously.
 * DB inserts are batched; socket and push fire per-admin in parallel.
 *
 * @param {string}   message
 * @param {string}   type
 * @param {string}   [url]
 * @param {object}   [socketEvent]   { event, payload } — emitted to admin_room
 * @param {object}   [pushPayload]
 */
async function dispatchToAdmins(message, type, url = '/admin/financial', socketEvent = null, pushPayload = null) {
  const admins = await fetchPayoutAdmins();
  if (!admins.length) return;

  // Batch DB insert
  let notifications = [];
  try {
    notifications = await Notification.insertMany(
      admins.map(a => ({ user: a._id, message, type, url })),
      { ordered: false }
    );
  } catch (err) {
    console.error('[rewardNotify] Admin batch insert failed:', err.message);
  }

  // Socket.IO — broadcast to the shared admin_room + each personal room
  try {
    const io = getIO();

    if (socketEvent) {
      io.to(ADMIN_ROOM).emit(socketEvent.event, socketEvent.payload);
    }

    // Personal room notification bell
    admins.forEach((a, i) => {
      io.to(String(a._id)).emit('notification', {
        _id:       notifications[i]?._id,
        type,
        message,
        url,
        createdAt: new Date(),
      });
    });
  } catch (err) {
    console.debug(`[rewardNotify] Admin socket skipped: ${err.message}`);
  }

  // Web push in parallel (non-blocking)
  const push = pushPayload ?? { title: 'SoShoLife Admin', message, url };
  await Promise.allSettled(
    admins.map(a => sendPushToUser(String(a._id), push).catch(() => {}))
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * User claimed a reward milestone.
 * Fires to: the claimant (confirmation) + all payout admins (action required).
 *
 * @param {object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.userName
 * @param {'post'|'referral'|'streak'} p.rewardType
 * @param {number|string}  p.milestone    e.g. 30, "30days", 10
 * @param {string}          p.planKey     '2500' | '3500' | '4500'
 * @param {number}          p.amountINR
 * @param {string}          [p.claimId]
 */
async function notifyRewardClaimed({
  userId, userName, rewardType, milestone, planKey, amountINR, claimId,
}) {
  const emoji   = TYPE_EMOJI[rewardType] || '🎁';
  const typeStr = capitalize(rewardType);
  const milestoneStr = rewardType === 'streak' ? `${milestone} day streak` : `${milestone} ${rewardType}s`;

  // ── To user (confirmation) ────────────────────────────────────────────────
  const userMsg = `${emoji} You claimed your ${typeStr} Reward for ${milestoneStr}! ${fmtINR(amountINR)} is being processed.`;
  await dispatchToUser(
    userId,
    userMsg,
    'custom',
    `/rewards/${rewardType}`,
    {
      title:   `${emoji} Reward Claimed!`,
      message: `${fmtINR(amountINR)} ${typeStr} reward for ${milestoneStr} is now in queue.`,
      url:     `/rewards/${rewardType}`,
    },
    { rewardType, milestone, amountINR, planKey }
  );

  // ── To admins (action required) ───────────────────────────────────────────
  const isHighValue = typeof amountINR === 'number' && amountINR >= HIGH_VALUE_INR_THRESHOLD;
  const adminMsg = `${emoji}${isHighValue ? ' 🔴 HIGH VALUE' : ''} New reward claim: ${userName} claimed ${fmtINR(amountINR)} (${typeStr} · ${milestoneStr} · Plan ₹${planKey})`;

  await dispatchToAdmins(
    adminMsg,
    'custom',
    '/admin/financial?tab=claims',
    {
      event: 'reward:new_claim',
      payload: {
        claimId,
        userId:     String(userId),
        userName,
        rewardType,
        milestone:  String(milestone),
        planKey,
        amountINR,
        isHighValue,
        claimedAt:  new Date(),
      },
    },
    {
      title:   `${emoji} New Reward Claim`,
      message: `${userName} — ${fmtINR(amountINR)} ${typeStr} reward needs processing`,
      url:     '/admin/financial?tab=claims',
    }
  );

  console.log(`[rewardNotify] ✅ notifyRewardClaimed: user=${userId} type=${rewardType} milestone=${milestone} INR=${amountINR}`);
}

/**
 * Payout status changed (by admin action).
 * Fires to: the claimant (status update) + all payout admins (audit feed).
 *
 * @param {object} p
 * @param {string} p.payoutId
 * @param {string|ObjectId} p.userId
 * @param {string} p.userName
 * @param {string} p.oldStatus
 * @param {string} p.newStatus
 * @param {number} p.amountINR
 * @param {string} [p.rewardType]
 * @param {string} [p.milestone]
 * @param {string} [p.transactionRef]
 * @param {string} [p.failureReason]
 * @param {string} [p.adminName]
 */
async function notifyPayoutStatusChanged({
  payoutId, userId, userName,
  oldStatus, newStatus, amountINR,
  rewardType = '', milestone = '',
  transactionRef = null, failureReason = null,
  adminName = 'An admin',
}) {
  const statusEmoji = STATUS_EMOJI[newStatus] || '📋';
  const typeLabel   = rewardType ? `${TYPE_EMOJI[rewardType] || ''} ${capitalize(rewardType)}` : 'Reward';

  // ── To user ───────────────────────────────────────────────────────────────
  let userMsg = '';
  let userUrl = '/rewards';

  if (newStatus === 'paid') {
    userMsg = `${statusEmoji} Great news, ${userName.split(' ')[0]}! Your ${typeLabel} payout of ${fmtINR(amountINR)} has been processed. ${transactionRef ? `Ref: ${transactionRef}` : ''}`.trim();
    userUrl = '/rewards/history';
  } else if (newStatus === 'processing') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} is now being processed. Expected within 3–5 business days.`;
  } else if (newStatus === 'failed') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} could not be completed. Reason: ${failureReason || 'Please contact support'}. We'll retry soon.`;
    userUrl = '/support';
  } else if (newStatus === 'on_hold') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} is temporarily on hold pending additional verification. Our team will contact you.`;
  } else if (newStatus === 'pending') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} has been queued for retry.`;
  }

  if (userMsg) {
    await dispatchToUser(
      userId,
      userMsg,
      'custom',
      userUrl,
      {
        title:   `${statusEmoji} Payout ${capitalize(newStatus)}`,
        message: userMsg,
        url:     userUrl,
      },
      { payoutId, oldStatus, newStatus, amountINR, transactionRef }
    );
  }

  // ── To admins (audit / feed) ──────────────────────────────────────────────
  const adminMsg = `${statusEmoji} Payout status: ${oldStatus} → ${newStatus} | ${userName} | ${fmtINR(amountINR)} ${typeLabel} ${milestone ? `(${milestone})` : ''} by ${adminName}`;

  await dispatchToAdmins(
    adminMsg,
    'custom',
    `/admin/financial?payoutId=${payoutId}`,
    {
      event: 'payout:status_changed',
      payload: {
        payoutId,
        userId:         String(userId),
        userName,
        oldStatus,
        newStatus,
        amountINR,
        rewardType,
        milestone,
        transactionRef,
        failureReason,
        changedAt:      new Date(),
      },
    },
    {
      title:   `${statusEmoji} Payout ${capitalize(newStatus)}`,
      message: `${userName} — ${fmtINR(amountINR)} payout ${oldStatus} → ${newStatus}`,
      url:     `/admin/financial?payoutId=${payoutId}`,
    }
  );

  console.log(`[rewardNotify] ✅ notifyPayoutStatusChanged: payout=${payoutId} ${oldStatus}→${newStatus}`);
}

/**
 * Grocery coupon redemption submitted by user.
 *
 * @param {object} p
 * @param {string|ObjectId} p.userId
 * @param {string}  p.userName
 * @param {number}  p.amountINR
 * @param {string}  p.payoutId
 */
async function notifyGroceryRedemptionSubmitted({ userId, userName, amountINR, payoutId }) {
  // ── To user (confirmation) ────────────────────────────────────────────────
  await dispatchToUser(
    userId,
    `🛒 Your grocery coupon redemption of ${fmtINR(amountINR)} has been received! We'll process it within 3–5 business days.`,
    'custom',
    '/rewards/history',
    {
      title:   '🛒 Redemption Received!',
      message: `${fmtINR(amountINR)} grocery redemption submitted. Processing in 3–5 business days.`,
      url:     '/rewards/history',
    }
  );

  // ── To admins ─────────────────────────────────────────────────────────────
  await dispatchToAdmins(
    `🛒 New grocery redemption: ${userName} requested ${fmtINR(amountINR)} cashout. Review in Financial → Payouts.`,
    'custom',
    '/admin/financial?tab=claims',
    {
      event: 'grocery:new_request',
      payload: {
        payoutId:    String(payoutId),
        userId:      String(userId),
        userName,
        amountINR,
        requestedAt: new Date(),
      },
    },
    {
      title:   '🛒 New Grocery Redemption',
      message: `${userName} requested ${fmtINR(amountINR)} — tap to process`,
      url:     '/admin/financial?tab=claims',
    }
  );

  console.log(`[rewardNotify] ✅ notifyGroceryRedemptionSubmitted: user=${userId} INR=${amountINR}`);
}

/**
 * Bulk payout batch completed.
 * Fires only to admins (summary of what happened).
 *
 * @param {object} p
 * @param {string}  p.adminId      The admin who ran the bulk action
 * @param {string}  p.adminName
 * @param {number}  p.processed
 * @param {number}  p.skipped
 * @param {number}  p.failed
 * @param {number}  p.totalINRDispatched
 */
async function notifyBulkPayoutComplete({ adminId, adminName, processed, skipped, failed, totalINRDispatched }) {
  const msg = `⚡ Bulk payout complete by ${adminName}: ${processed} processed (${fmtINR(totalINRDispatched)}), ${skipped} skipped, ${failed} failed.`;

  await dispatchToAdmins(
    msg,
    'custom',
    '/admin/financial?tab=payouts',
    {
      event: 'payout:bulk_complete',
      payload: {
        adminId,
        adminName,
        processed,
        skipped,
        failed,
        totalINRDispatched,
        completedAt: new Date(),
      },
    },
    {
      title:   '⚡ Bulk Payout Done',
      message: `${processed} payouts dispatched (${fmtINR(totalINRDispatched)}) — ${failed} failed`,
      url:     '/admin/financial?tab=payouts',
    }
  );

  console.log(`[rewardNotify] ✅ notifyBulkPayoutComplete: by=${adminId} processed=${processed} INR=${totalINRDispatched}`);
}

/**
 * User tried to claim a reward while their rewards are frozen.
 * Fires only to admins — signals a user who may need manual review.
 *
 * @param {object} p
 * @param {string|ObjectId} p.userId
 * @param {string} p.userName
 * @param {string} p.rewardType
 * @param {string|number} p.milestone
 */
async function notifyFrozenClaimAttempt({ userId, userName, rewardType, milestone }) {
  const msg = `🔴 Frozen-account claim attempt: ${userName} tried to claim a ${capitalize(rewardType)} reward (milestone: ${milestone}) but rewards are frozen.`;

  await dispatchToAdmins(
    msg,
    'custom',
    `/admin/users?userId=${String(userId)}`,
    {
      event: 'reward:frozen_attempt',
      payload: {
        userId:    String(userId),
        userName,
        rewardType,
        milestone: String(milestone),
        attemptAt: new Date(),
      },
    },
    {
      title:   '🔴 Frozen Claim Attempt',
      message: `${userName} attempted a ${rewardType} claim — account rewards are frozen`,
      url:     `/admin/users?userId=${String(userId)}`,
    }
  );

  console.log(`[rewardNotify] ⚠️  notifyFrozenClaimAttempt: user=${userId} type=${rewardType}`);
}

module.exports = {
  notifyRewardClaimed,
  notifyPayoutStatusChanged,
  notifyGroceryRedemptionSubmitted,
  notifyBulkPayoutComplete,
  notifyFrozenClaimAttempt,

  // Expose helpers for testing / custom calls
  dispatchToUser,
  dispatchToAdmins,
  HIGH_VALUE_INR_THRESHOLD,
};