// services/defenseActions.js
// Applies automated trust & safety actions when risk thresholds are exceeded.
// Every action is:
//   1. Written to User document (state change)
//   2. Recorded in FraudEvent (immutable audit trail)
//   3. Emitted as a WebSocket event to the admin dashboard
//
// IMPORTANT: Every action must be reversible by an admin via the undo panel.
'use strict';

const User = require('../models/User');
const FraudEvent = require('../models/FraudEvent');
const { getIO } = require('../sockets/IOsocket');

// ── Action definitions ────────────────────────────────────────────────────────
const ACTIONS = {
  FREEZE_REWARDS: 'freeze_rewards',
  DISABLE_REFERRAL: 'disable_referral_link',
  REQUIRE_KYC: 'require_kyc',
  SHADOW_BAN: 'shadow_ban',
  QUEUE_MANUAL_REVIEW: 'queue_manual_review',
  FLAG_WATCHLIST: 'flag_watchlist',
};

// ── Tier → action mapping ─────────────────────────────────────────────────────
const TIER_ACTIONS = {
  watchlist: [ACTIONS.FLAG_WATCHLIST],
  kyc_gate: [ACTIONS.FLAG_WATCHLIST, ACTIONS.REQUIRE_KYC, ACTIONS.FREEZE_REWARDS],
  auto_flag: [
    ACTIONS.FLAG_WATCHLIST,
    ACTIONS.REQUIRE_KYC,
    ACTIONS.FREEZE_REWARDS,
    ACTIONS.DISABLE_REFERRAL,
    ACTIONS.QUEUE_MANUAL_REVIEW,
  ],
};

// ── Apply state changes to User document ────────────────────────────────────
async function applyUserStateChanges(userId, actions) {
  const update = {};

  if (actions.includes(ACTIONS.FREEZE_REWARDS)) {
    update['trustFlags.rewardsFrozen'] = true;
    update['trustFlags.rewardsFrozenAt'] = new Date();
  }
  if (actions.includes(ACTIONS.DISABLE_REFERRAL)) {
    update['trustFlags.referralDisabled'] = true;
  }
  if (actions.includes(ACTIONS.REQUIRE_KYC)) {
    update['trustFlags.kycRequired'] = true;
  }
  if (actions.includes(ACTIONS.SHADOW_BAN)) {
    update['trustFlags.shadowBanned'] = true;
  }
  if (actions.includes(ACTIONS.FLAG_WATCHLIST)) {
    update['trustFlags.onWatchlist'] = true;
  }
  if (actions.includes(ACTIONS.QUEUE_MANUAL_REVIEW)) {
    update['trustFlags.pendingManualReview'] = true;
    update['trustFlags.reviewQueuedAt'] = new Date();
  }
  if (actions.includes(ACTIONS.REQUIRE_KYC)) {
    update['kyc.status'] = 'required';
    update['kyc.requiredAt'] = new Date();
  }

  if (Object.keys(update).length > 0) {
    await User.findByIdAndUpdate(userId, { $set: update });
  }
}

// ── Emit admin dashboard event ────────────────────────────────────────────────
function emitAdminAlert(fraudEvent) {
  try {
    const io = getIO();
    io.to('admin_room').emit('trust:alert', {
      fraudEventId: String(fraudEvent._id),
      userId: String(fraudEvent.userId),
      score: fraudEvent.scores.aggregateRiskScore,
      actions: fraudEvent.actionsTriggered,
      explanation: fraudEvent.explanation,
      triggeredAt: fraudEvent.createdAt,
    });
  } catch (err) {
    // Non-fatal — dashboard alert failure should never block the core action
    console.error('[defenseActions] WebSocket emit failed:', err.message);
  }
}

// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Execute defense actions for a user based on their risk tier.
 *
 * @param {string|ObjectId} userId
 * @param {object} scoreResult   Output from computeMultiAccountScore()
 * @param {string} triggerEvent  The platform event that caused this evaluation
 * @param {object} eventPayload  Raw event data for the audit log
 * @param {object} extraScores   Optional additional scores (referralAbuse etc.)
 */
async function executeDefenseActions(userId, scoreResult, triggerEvent, eventPayload = {}, extraScores = {}) {
  const { score, tier, breakdown, explanation } = scoreResult;

  // Determine which actions to apply
  const actions = TIER_ACTIONS[tier] || [];

  // Always write a FraudEvent regardless of tier (for full audit trail)
  const fraudEvent = await FraudEvent.create({
    userId,
    triggerEvent,
    scores: {
      deviceSimilarity: breakdown.deviceSimilarity,
      networkSimilarity: breakdown.networkSimilarity,
      behaviorSimilarity: breakdown.behaviorSimilarity,
      graphClusterDensity: breakdown.graphClusterDensity,
      multiAccountScore: score,
      referralAbuse: extraScores.referralAbuse ?? null,
      velocityScore: extraScores.velocityScore ?? null,
      aggregateRiskScore: score,
    },
    explanation,
    actionsTriggered: actions,
    eventPayload,
  });

  // Apply state changes
  if (actions.length > 0) {
    await applyUserStateChanges(userId, actions);
    // Update aggregateRiskScore on the user document for quick queries
    await User.findByIdAndUpdate(userId, {
      $set: {
        'trustFlags.riskScore': score,
        'trustFlags.riskTier': tier,
        'trustFlags.lastEvaluatedAt': new Date(),
      },
    });
  }

  // Alert admin dashboard if score is above watchlist
  if (tier !== 'clean') {
    emitAdminAlert(fraudEvent);
  }

  return {
    fraudEventId: String(fraudEvent._id),
    actions,
    tier,
    score,
  };
}

// ── Reverse an action (called by admin undo panel) ─────────────────────────
/**
 * Reverses a specific trust action on a user.
 * Writes a resolution note to the original FraudEvent.
 */
async function reverseDefenseAction(fraudEventId, adminId, resolution, note) {
  const fraudEvent = await FraudEvent.findById(fraudEventId);
  if (!fraudEvent) throw new Error(`FraudEvent ${fraudEventId} not found`);

  const userId = fraudEvent.userId;
  const actions = fraudEvent.actionsTriggered;

  // Build the inverse update
  const update = {};
  if (actions.includes(ACTIONS.FREEZE_REWARDS)) update['trustFlags.rewardsFrozen'] = false;
  if (actions.includes(ACTIONS.DISABLE_REFERRAL)) update['trustFlags.referralDisabled'] = false;
  if (actions.includes(ACTIONS.REQUIRE_KYC)) update['trustFlags.kycRequired'] = false;
  if (actions.includes(ACTIONS.SHADOW_BAN)) update['trustFlags.shadowBanned'] = false;
  if (actions.includes(ACTIONS.FLAG_WATCHLIST)) update['trustFlags.onWatchlist'] = false;
  if (actions.includes(ACTIONS.QUEUE_MANUAL_REVIEW)) update['trustFlags.pendingManualReview'] = false;

  await User.findByIdAndUpdate(userId, { $set: update });

  // Mark fraud event as resolved
  await FraudEvent.findByIdAndUpdate(fraudEventId, {
    $set: {
      resolved: true,
      resolvedBy: adminId,
      resolvedAt: new Date(),
      resolution,
    },
  });

  return { userId, actionsReversed: actions };
}

module.exports = { executeDefenseActions, reverseDefenseAction, ACTIONS, TIER_ACTIONS };