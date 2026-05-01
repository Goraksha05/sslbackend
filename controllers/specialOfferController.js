/**
 * controllers/specialOfferController.js
**/

'use strict';

const User        = require('../models/User');
const Payout      = require('../models/PayoutSchema');
const Notification = require('../models/Notification');
const { getIO }   = require('../sockets/socketManager');
const { computeMultiAccountScore }  = require('../services/multiAccountScorer');
const { computeReferralAbuseScore } = require('../services/referralAbuseScorer');
const { executeDefenseActions }     = require('../services/defenseActions');

const OFFER_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours
const REWARD_PER_REFERRAL = 100;                 // ₹100
const DAILY_CAP_INR = 1800;                      // ₹1800/day
const PAYOUT_TYPE   = 'special_offer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOfferValid(user) {
  const offer = user.specialOffer;
  if (!offer?.isActive) return false;
  if (!offer.expiresAt) return false;
  return new Date() < new Date(offer.expiresAt);
}

function emitSpecialOfferUpdate(userId) {
  const io = getIO();
  io.to(userId.toString()).emit("special_offer:update");
}

/** Total earned from special offer rewards in the calendar day (IST) */
async function getTodayEarnings(userId) {
  const now         = new Date();
  const istDateStr  = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  // IST is UTC+5:30 — midnight IST = (date)T00:00:00+05:30 = (date-1)T18:30:00Z
  const startOfDayIST = new Date(`${istDateStr}T00:00:00+05:30`);

  const user = await User.findById(userId)
    .select('lockedRewards')
    .lean();

  const todayRewards = (user?.lockedRewards ?? []).filter(r => {
    return (
      r.type === PAYOUT_TYPE &&
      ['pending', 'approved'].includes(r.status) &&
      new Date(r.createdAt) >= startOfDayIST
    );
  });

  return todayRewards.reduce((sum, r) => sum + (r.amount || 0), 0);
}

// ── GET /api/special-offer/status ────────────────────────────────────────────
/**
 * Returns the offer status for the authenticated user.
 *
 * Response:
 *   { isActive, expiresIn (seconds), expiresAt, earned, pendingCount,
 *     referrals, dailyCap, todayEarned, canEarnMore }
 */
exports.getStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('specialOffer lockedRewards')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const offer = user.specialOffer;

    // Expired or never activated
    if (!offer?.isActive || !offer.expiresAt || new Date() >= new Date(offer.expiresAt)) {
      return res.json({
        isActive:     false,
        expiresIn:    0,
        expiresAt:    offer?.expiresAt ?? null,
        earned:       offer?.totalEarned ?? 0,
        referrals:    offer?.referralCount ?? 0,
        pendingCount: 0,
        todayEarned:  0,
        dailyCap:     DAILY_CAP_INR,
        canEarnMore:  false,
      });
    }

    const expiresAt  = new Date(offer.expiresAt);
    const expiresIn  = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

    const lockedRewards = user.lockedRewards ?? [];
    const earned        = lockedRewards
      .filter(r => r.type === PAYOUT_TYPE)
      .reduce((s, r) => s + (r.amount || 0), 0);

    const pendingCount = lockedRewards.filter(
      r => r.type === PAYOUT_TYPE && r.status === 'pending'
    ).length;

    const todayEarned = await getTodayEarnings(user._id);
    const canEarnMore = todayEarned < DAILY_CAP_INR;

    return res.json({
      isActive:     true,
      expiresIn,
      expiresAt:    offer.expiresAt,
      startAt:      offer.startAt,
      earned:       offer.totalEarned ?? earned,
      referrals:    offer.referralCount ?? 0,
      pendingCount,
      todayEarned,
      dailyCap:     DAILY_CAP_INR,
      canEarnMore,
      rewardPerReferral: REWARD_PER_REFERRAL,
    });
  } catch (err) {
    console.error('[specialOffer] getStatus error:', err);
    return res.status(500).json({ message: 'Failed to fetch offer status.' });
  }
};

// ── Called internally when a referred user completes KYC ─────────────────────
/**
 * Credit ₹100 to the referrer if:
 *   1. Their 12-hour offer window is still active
 *   2. They haven't hit the daily cap
 *   3. Trust checks pass
 *
 * @param {string|ObjectId} referrerId  - ID of the user who made the referral
 * @param {string|ObjectId} referredId  - ID of the newly KYC-verified user
 * @returns {Promise<{ credited: boolean, reason?: string }>}
 */
exports.creditReferralReward = async (referrerId, referredId) => {
  try {
    const referrer = await User.findById(referrerId);
    if (!referrer) return { credited: false, reason: 'Referrer not found' };

    if (!isOfferValid(referrer)) {
      return { credited: false, reason: 'Offer expired or inactive' };
    }

    if (referrer.trustFlags?.rewardsFrozen) {
      return { credited: false, reason: 'Rewards frozen' };
    }

    const todayEarned = await getTodayEarnings(referrerId);
    if (todayEarned + REWARD_PER_REFERRAL > DAILY_CAP_INR) {
      return { credited: false, reason: 'Daily cap reached' };
    }

    const alreadyRewarded = (referrer.lockedRewards ?? []).some(
      r => r.referredUserId?.toString() === referredId.toString() && r.type === PAYOUT_TYPE
    );
    if (alreadyRewarded) {
      return { credited: false, reason: 'Already credited for this referral' };
    }

    // ── Trust & fraud scoring (async, non-blocking for UI) ─────────────────
    setImmediate(async () => {
      try {
        const [maResult, raResult] = await Promise.all([
          computeMultiAccountScore(referrerId, {}),
          computeReferralAbuseScore(referrerId),
        ]);
        if (maResult.tier !== 'clean' || raResult.score > 0.7) {
          await executeDefenseActions(
            referrerId, maResult, 'reward_claim', { specialOffer: true },
            { referralAbuse: raResult.score }
          );
        }
      } catch (trustErr) {
        console.error('[specialOffer] trust check failed:', trustErr.message);
      }
    });

    const newReward = {
      amount:         REWARD_PER_REFERRAL,
      type:           PAYOUT_TYPE,
      status:         'pending',
      referredUserId: referredId,
      createdAt:      new Date(),
    };

    const updated = await User.findByIdAndUpdate(
      referrerId,
      {
        $push: { lockedRewards: newReward },
        $inc: {
          'specialOffer.totalEarned':  REWARD_PER_REFERRAL,
          'specialOffer.referralCount': 1,
        },
      },
      { new: true }
    );

    if (!updated) return { credited: false, reason: 'Update failed' };

    await Payout.create({
      user:          referrerId,
      rewardType:    PAYOUT_TYPE,
      milestone:     `special_offer_referral_${referredId}`,
      planKey:       updated.subscription?.planAmount
        ? String(updated.subscription.planAmount)
        : '2500',
      breakdown:     { groceryCoupons: REWARD_PER_REFERRAL, shares: 0, referralToken: 0 },
      cashAmountINR:  REWARD_PER_REFERRAL,
      totalAmountINR: REWARD_PER_REFERRAL,
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
      bankDetails: {
        accountNumber: updated.bankDetails?.accountNumber ?? null,
        ifscCode:      updated.bankDetails?.ifscCode      ?? null,
        panNumber:     updated.bankDetails?.panNumber      ?? null,
      },
      status:        'pending',
      userRequested: false,
      notes:         `Special offer referral reward — ₹${REWARD_PER_REFERRAL} for referring user ${referredId}`,
    }).catch(err => {
      // Non-fatal — wallet is already credited, payout record is for admin panel
      console.error('[specialOffer] Payout.create failed (non-fatal):', err.message);
    });

    // ── Notify the referrer ───────────────────────────────────────────────
    try {
      await Notification.create({
        user:    referrerId,
        type:    'referral_reward',
        message: `🎉 You earned ₹${REWARD_PER_REFERRAL} from your special offer referral! It's pending admin approval.`,
        url:     '/rewards?tab=special',
      });

      getIO()
        .to(referrerId.toString())
        .emit('special_offer_reward', {
          amount:   REWARD_PER_REFERRAL,
          message:  `You earned ₹${REWARD_PER_REFERRAL}!`,
        });
    } catch (notifyErr) {
      console.debug('[specialOffer] notification failed (non-fatal):', notifyErr.message);
    }

    console.log(`[specialOffer] ✅ Credited ₹${REWARD_PER_REFERRAL} to ${referrerId} for referring ${referredId}`);
    return { credited: true, amount: REWARD_PER_REFERRAL };

  } catch (err) {
    console.error('[specialOffer] creditReferralReward error:', err);
    return { credited: false, reason: err.message };
  }
};

// ── GET /api/special-offer/locked-rewards ─────────────────────────────────────
/**
 * Returns the user's locked rewards list with status breakdown.
 */
exports.getLockedRewards = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('lockedRewards')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    const rewards = (user.lockedRewards ?? [])
      .filter(r => r.type === PAYOUT_TYPE)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const availableStatuses = new Set(['pending', 'approved']);

    const summary = {
      total:    rewards.length,
      pending:  rewards.filter(r => r.status === 'pending').length,
      approved: rewards.filter(r => r.status === 'approved').length,
      rejected: rewards.filter(r => r.status === 'rejected').length,
      totalINR: rewards
        .filter(r => r.status !== 'rejected')
        .filter(r => availableStatuses.has(r.status))
        .reduce((s, r) => s + (r.amount || 0), 0),
      // NEW: count of rewards consumed as subscription credit
      usedForSubscription:  rewards.filter(r => r.status === 'used_for_subscription').length,
      // NEW: amount that was applied toward subscription purchases
      totalUsedINR: rewards
        .filter(r => r.status === 'used_for_subscription')
        .reduce((s, r) => s + (r.amount || 0), 0),

      // NEW: gross lifetime total regardless of status
      totalEarned: rewards
        .filter(r => r.status !== 'rejected')
        .reduce((s, r) => s + (r.amount || 0), 0),      
    };

    return res.json({ rewards, summary });
  } catch (err) {
    console.error('[specialOffer] getLockedRewards error:', err);
    return res.status(500).json({ message: 'Failed to fetch locked rewards.' });
  }
};

// ── POST /api/special-offer/withdraw ─────────────────────────────────────────
/**
 * User-initiated withdrawal of approved special-offer rewards.
 *
 * Guards:
 *   - KYC must be verified
 *   - At least one approved locked reward must exist
 *   - Bank details saved with the request are merged onto the user document
 *
 * Creates a Payout record with userRequested: true so the admin panel
 * surfaces it in the "Pending Claims" tab (not "Unredeemed Wallets").
 */
exports.withdraw = async (req, res) => {
  try {
    const userId     = req.user.id;
    const { bankDetails } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // ── KYC gate ──────────────────────────────────────────────────────────
    if (user.kyc?.status !== 'verified') {
      return res.status(403).json({
        message: 'KYC verification is required before withdrawing rewards.',
      });
    }

    // ── Find approved rewards ─────────────────────────────────────────────
    const approvedRewards = (user.lockedRewards ?? []).filter(
      r => r.type === PAYOUT_TYPE && r.status === 'approved'
    );

    if (approvedRewards.length === 0) {
      return res.status(400).json({
        message: 'No approved rewards available to withdraw. Approval takes 24–48 hrs.',
      });
    }

    // ── Merge bank details ────────────────────────────────────────────────
    if (bankDetails) {
      if (!user.bankDetails) user.bankDetails = {};
      if (bankDetails.accountNumber?.trim()) {
        user.bankDetails.accountNumber = bankDetails.accountNumber.trim();
      }
      if (bankDetails.ifscCode?.trim()) {
        user.bankDetails.ifscCode = bankDetails.ifscCode.trim().toUpperCase();
      }
      if (bankDetails.panNumber?.trim()) {
        user.bankDetails.panNumber = bankDetails.panNumber.trim().toUpperCase();
      }
      await user.save();
    }

    const totalApproved = approvedRewards.reduce((s, r) => s + (r.amount || 0), 0);

    // ── Create Payout record for admin panel ──────────────────────────────
    const payout = await Payout.create({
      user:          userId,
      rewardType:    PAYOUT_TYPE,
      milestone:     `special_offer_withdrawal_${Date.now()}`,
      planKey:       user.subscription?.planAmount
        ? String(user.subscription.planAmount)
        : '2500',
      breakdown:     { groceryCoupons: totalApproved, shares: 0, referralToken: 0 },
      cashAmountINR:  totalApproved,
      totalAmountINR: totalApproved,
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
      bankDetails: {
        accountNumber: user.bankDetails?.accountNumber ?? null,
        ifscCode:      user.bankDetails?.ifscCode      ?? null,
        panNumber:     user.bankDetails?.panNumber     ?? null,
      },
      status:        'pending',
      userRequested: true,  // shows in admin "Pending Claims" tab
      notes:         `Special offer withdrawal — ₹${totalApproved} from ${approvedRewards.length} approved reward(s)`,
    });

    // ── Notify admin via socket ───────────────────────────────────────────
    try {
      getIO()
        .to('admin_room')
        .emit('special_offer_withdrawal_requested', {
          userId:  userId.toString(),
          amount:  totalApproved,
          payoutId: payout._id.toString(),
        });
    } catch (sockErr) {
      console.debug('[specialOffer] admin socket notify failed (non-fatal):', sockErr.message);
    }

    console.log(`[specialOffer] ✅ Withdrawal requested by ${userId} — ₹${totalApproved}`);

    return res.json({
      message: `Withdrawal request of ₹${totalApproved} submitted. Admin will process within 24–48 hrs.`,
      payoutId: payout._id,
      amount:   totalApproved,
    });
  } catch (err) {
    console.error('[specialOffer] withdraw error:', err);
    return res.status(500).json({ message: 'Failed to submit withdrawal request.' });
  }
};