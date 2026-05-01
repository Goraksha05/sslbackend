/**
 * services/rewardNotificationService.js
**/

'use strict';

const User         = require('../models/User');
const Notification = require('../models/Notification');
const AdminRole    = require('../models/AdminRole');
const { getIO }              = require('../sockets/socketManager');
const { sendPushToUser }     = require('../utils/pushService');
const { buildPushPayload, BRAND } = require('../utils/notifyUser');

// ── Configuration ─────────────────────────────────────────────────────────────
const HIGH_VALUE_INR_THRESHOLD = 5000;
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

// ── Core dispatcher ────────────────────────────────────────────────────────────
/**
 * Fire a branded notification to a single user across all three channels.
 *
 * The SoShoLife logo is automatically included in every push notification
 * via buildPushPayload — callers never need to pass icon/badge/image.
 */
async function dispatchToUser(
  userId,
  message,
  type,
  url           = '/',
  pushPayload   = null,
  socketPayload = {}
) {
  const uid = String(userId);

  if (!uid || uid === 'undefined') {
    console.warn('[rewardNotify] Invalid userId');
    return null;
  }

  // 1 — DB
  let notif = null;
  try {
    notif = await Notification.create({ user: userId, message, type, url });
  } catch (err) {
    console.error(`[rewardNotify] DB write failed for ${uid}:`, err.message);
  }

  // 2 — Socket
  let socketDelivered = false;
  try {
    const io = getIO();
    io.to(uid).emit('notification', {
      _id:       notif?._id,
      type,
      message,
      url,
      icon:      BRAND.icon,   // logo in the in-app notification bell
      ...(socketPayload || {}),
      createdAt: notif?.createdAt || new Date(),
    });
    socketDelivered = true;
  } catch (err) {
    console.debug(`[rewardNotify] Socket skipped for ${uid}: ${err.message}`);
  }

  // 3 — Push (branded logo always included)
  try {
    if (!socketDelivered) {
      // If caller supplied a pushPayload, merge logo fields into it.
      // Otherwise build one from scratch with the logo.
      const branded = pushPayload
        ? { ...BRAND, ...pushPayload }           // logo is base, caller overrides
        : buildPushPayload(BRAND.name, message, url);

      await sendPushToUser(uid, branded);
    }
  } catch (err) {
    console.debug(`[rewardNotify] Push skipped for ${uid}: ${err.message}`);
  }

  return notif;
}

/**
 * Broadcast a branded notification to all payout-admin users simultaneously.
 */
async function dispatchToAdmins(
  message,
  type,
  url          = '/admin/financial',
  socketEvent  = null,
  pushPayload  = null
) {
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

  // Socket.IO
  try {
    const io = getIO();

    if (socketEvent) {
      io.to(ADMIN_ROOM).emit(socketEvent.event, socketEvent.payload);
    }

    admins.forEach((a, i) => {
      io.to(String(a._id)).emit('notification', {
        _id:       notifications[i]?._id,
        type,
        message,
        url,
        icon:      BRAND.icon,
        createdAt: new Date(),
      });
    });
  } catch (err) {
    console.debug(`[rewardNotify] Admin socket skipped: ${err.message}`);
  }

  // Branded push
  const branded = pushPayload
    ? { ...BRAND, ...pushPayload }
    : buildPushPayload('SoShoLife Admin', message, url);

  await Promise.allSettled(
    admins.map(a => sendPushToUser(String(a._id), branded).catch(() => {}))
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API  (signatures unchanged — callers need zero changes)
// ═════════════════════════════════════════════════════════════════════════════

async function notifyRewardClaimed({
  userId, userName, rewardType, milestone, planKey, amountINR, claimId,
}) {
  const emoji        = TYPE_EMOJI[rewardType] || '🎁';
  const typeStr      = capitalize(rewardType);
  const milestoneStr = rewardType === 'streak'
    ? `${milestone} day streak`
    : `${milestone} ${rewardType}s`;

  // ── To user ───────────────────────────────────────────────────────────────
  const userMsg = `${emoji} You claimed your ${typeStr} Reward for ${milestoneStr}! ${fmtINR(amountINR)} in grocery coupons is being processed as a cash payout.`;

  await dispatchToUser(
    userId,
    userMsg,
    'custom',
    `/rewards/${rewardType}`,
    buildPushPayload(
      `${emoji} Reward Claimed!`,
      `${fmtINR(amountINR)} grocery coupon cash reward for ${milestoneStr} is now in queue.`,
      `/rewards/${rewardType}`
    ),
    { rewardType, milestone, amountINR, planKey }
  );

  // ── To admins ─────────────────────────────────────────────────────────────
  const isHighValue = typeof amountINR === 'number' && amountINR >= HIGH_VALUE_INR_THRESHOLD;
  const adminMsg    = `${emoji}${isHighValue ? ' 🔴 HIGH VALUE' : ''} New reward claim: ${userName} claimed ${fmtINR(amountINR)} (${typeStr} · ${milestoneStr} · Plan ₹${planKey})`;

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
    buildPushPayload(
      `${emoji} New Reward Claim`,
      `${userName} — ${fmtINR(amountINR)} ${typeStr} reward needs processing`,
      '/admin/financial?tab=claims'
    )
  );

  console.log(`[rewardNotify] ✅ notifyRewardClaimed: user=${userId} type=${rewardType} milestone=${milestone} INR=${amountINR}`);
}

async function notifyPayoutStatusChanged({
  payoutId, userId, userName,
  oldStatus, newStatus, amountINR,
  rewardType = '', milestone = '',
  transactionRef = null, failureReason = null,
  adminName = 'An admin',
}) {
  const statusEmoji = STATUS_EMOJI[newStatus] || '📋';
  const typeLabel   = rewardType
    ? `${TYPE_EMOJI[rewardType] || ''} ${capitalize(rewardType)}`
    : 'Reward';

  // ── To user ───────────────────────────────────────────────────────────────
  let userMsg = '';
  let userUrl = '/rewards';

  if (newStatus === 'paid') {
    userMsg = `${statusEmoji} Great news, ${userName.split(' ')[0]}! Your ${typeLabel} grocery coupon payout of ${fmtINR(amountINR)} has been transferred to your bank account. ${transactionRef ? `Ref: ${transactionRef}` : ''}`.trim();
    userUrl = '/rewards/history';
  } else if (newStatus === 'processing') {
    userMsg = `${statusEmoji} Your ${typeLabel} grocery coupon cash payout of ${fmtINR(amountINR)} is now being processed. Expected within 3–5 business days.`;
  } else if (newStatus === 'failed') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} could not be completed. Reason: ${failureReason || 'Please contact support'}. We'll retry soon.`;
    userUrl = '/support';
  } else if (newStatus === 'on_hold') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} is temporarily on hold pending additional verification.`;
  } else if (newStatus === 'pending') {
    userMsg = `${statusEmoji} Your ${typeLabel} payout of ${fmtINR(amountINR)} has been queued for retry.`;
  }

  if (userMsg) {
    await dispatchToUser(
      userId,
      userMsg,
      'custom',
      userUrl,
      buildPushPayload(
        `${statusEmoji} Payout ${capitalize(newStatus)}`,
        userMsg,
        userUrl
      ),
      { payoutId, oldStatus, newStatus, amountINR, transactionRef }
    );
  }

  // ── To admins ─────────────────────────────────────────────────────────────
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
    buildPushPayload(
      `${statusEmoji} Payout ${capitalize(newStatus)}`,
      `${userName} — ${fmtINR(amountINR)} payout ${oldStatus} → ${newStatus}`,
      `/admin/financial?payoutId=${payoutId}`
    )
  );

  console.log(`[rewardNotify] ✅ notifyPayoutStatusChanged: payout=${payoutId} ${oldStatus}→${newStatus}`);
}

async function notifyGroceryRedemptionSubmitted({ userId, userName, amountINR, payoutId }) {
  await dispatchToUser(
    userId,
    `🛒 Your grocery coupon redemption of ${fmtINR(amountINR)} has been received! We'll process it within 3–5 business days.`,
    'custom',
    '/rewards/history',
    buildPushPayload(
      '🛒 Redemption Received!',
      `${fmtINR(amountINR)} grocery redemption submitted. Processing in 3–5 business days.`,
      '/rewards/history'
    )
  );

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
    buildPushPayload(
      '🛒 New Grocery Redemption',
      `${userName} requested ${fmtINR(amountINR)} — tap to process`,
      '/admin/financial?tab=claims'
    )
  );

  console.log(`[rewardNotify] ✅ notifyGroceryRedemptionSubmitted: user=${userId} INR=${amountINR}`);
}

async function notifyBulkPayoutComplete({
  adminId, adminName, processed, skipped, failed,
  totalCashINRDispatched, totalObjectRewardsHeld = {}, forcedToOnHoldCount = 0,
}) {
  const heldParts = [];
  if (totalObjectRewardsHeld.sharesHeld > 0)
    heldParts.push(`${totalObjectRewardsHeld.sharesHeld} shares`);
  if (totalObjectRewardsHeld.referralTokenHeld > 0)
    heldParts.push(`${totalObjectRewardsHeld.referralTokenHeld} tokens`);
  const heldStr   = heldParts.length > 0 ? ` | Object rewards held: ${heldParts.join(', ')}` : '';
  const onHoldStr = forcedToOnHoldCount > 0 ? ` | ${forcedToOnHoldCount} set to on_hold (zero cash)` : '';

  const msg = `⚡ Bulk payout complete by ${adminName}: ${processed} processed (${fmtINR(totalCashINRDispatched)} cash)${onHoldStr}, ${skipped} skipped, ${failed} failed${heldStr}.`;

  await dispatchToAdmins(
    msg,
    'custom',
    '/admin/financial?tab=payouts',
    {
      event: 'payout:bulk_complete',
      payload: {
        adminId, adminName, processed, skipped, failed,
        totalCashINRDispatched, totalObjectRewardsHeld,
        forcedToOnHoldCount, completedAt: new Date(),
      },
    },
    buildPushPayload(
      '⚡ Bulk Payout Done',
      `${processed} payouts dispatched (${fmtINR(totalCashINRDispatched)} cash) — ${failed} failed`,
      '/admin/financial?tab=payouts'
    )
  );

  console.log(`[rewardNotify] ✅ notifyBulkPayoutComplete: by=${adminId} processed=${processed} cashINR=${totalCashINRDispatched}`);
}

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
    buildPushPayload(
      '🔴 Frozen Claim Attempt',
      `${userName} attempted a ${rewardType} claim — account rewards are frozen`,
      `/admin/users?userId=${String(userId)}`
    )
  );

  console.log(`[rewardNotify] ⚠️  notifyFrozenClaimAttempt: user=${userId} type=${rewardType}`);
}

module.exports = {
  notifyRewardClaimed,
  notifyPayoutStatusChanged,
  notifyGroceryRedemptionSubmitted,
  notifyBulkPayoutComplete,
  notifyFrozenClaimAttempt,
  dispatchToUser,
  dispatchToAdmins,
  HIGH_VALUE_INR_THRESHOLD,
};