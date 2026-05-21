/**
 * controllers/specialOfferController.js
 *
 * Special Offer Reward System — Dual Redemption Paths
 * ─────────────────────────────────────────────────────
 *
 * HOW REWARDS FLOW
 * ────────────────
 * 1. User refers someone during their 12-hour offer window.
 * 2. When the referred user completes KYC, creditReferralReward() is called.
 *    → lockedRewards entry created with status: 'pending'
 *    → Payout record created with status: 'pending' (visible in admin panel)
 *    → Admin reviews and approves/rejects in the admin panel
 *    → On approval: lockedRewards[].status → 'approved'
 *
 * REDEMPTION — TWO PATHS, ONE CHOICE
 * ────────────────────────────────────
 * PATH A — Apply to Annual Subscription (Tax-Free)
 *   • User applies approved rewards as a credit against their next annual plan
 *   • Handled entirely in payment.js (verify-with-credit / activate-free-with-credit)
 *   • No cash changes hands → NO TDS → 100% face value used
 *   • lockedRewards[].status → 'used_for_subscription'
 *
 * PATH B — Cash Withdrawal (Taxable)
 *   • User requests a cash withdrawal of approved rewards
 *   • TDS (Tax Deducted at Source) at TDS_RATE is deducted from gross amount
 *     per Indian Income Tax Act Section 194R (benefits/gifts > ₹20,000/year)
 *   • Admin processes net payment to user's bank account
 *   • lockedRewards[].status → 'withdrawn'
 *   • Payout record: status 'pending' → admin marks 'paid' after bank transfer
 *
 * IMPORTANT: Once rewards are used for subscription, they CANNOT be withdrawn
 * as cash (and vice versa). The choice is permanent per reward entry.
 *
 * TAX NOTE (Indian regulations):
 *   Section 194R TDS applies to benefits/perquisites received in the course
 *   of business. For rewards > ₹20,000 aggregate in a financial year, TDS
 *   is mandatory. This implementation deducts TDS at TDS_RATE on the gross
 *   withdrawal amount. The admin panel shows gross, TDS, and net amounts.
 *   Consult your CA to confirm applicable rate for your platform's structure.
 */

'use strict';

const User         = require('../models/User');
const Payout       = require('../models/PayoutSchema');
const Notification = require('../models/Notification');
const { getIO }    = require('../sockets/socketManager');
const { computeMultiAccountScore }  = require('../services/multiAccountScorer');
const { computeReferralAbuseScore } = require('../services/referralAbuseScorer');
const { executeDefenseActions }     = require('../services/defenseActions');

// ── Constants ─────────────────────────────────────────────────────────────────

const OFFER_DURATION_MS   = 12 * 60 * 60 * 1000; // 12 hours
const REWARD_PER_REFERRAL = 100;                   // ₹100 per KYC-verified referral
const DAILY_CAP_INR       = 1800;                  // ₹1800 max earnings per day
const PAYOUT_TYPE         = 'special_offer';

/**
 * TDS rate applied to CASH WITHDRAWALS of Special Offer rewards.
 *
 * Indian Income Tax Act Section 194R: TDS on benefits/perquisites.
 * Rate: 10% (as of FY 2022-23 onwards for benefits > ₹20,000/year).
 * Consult your CA — adjust this constant if your applicable rate differs.
 *
 * PATH A (subscription credit) is NOT subject to TDS since no cash is paid.
 */
const TDS_RATE = 0.10; // 10%

/**
 * Minimum aggregate approved balance required to request a cash withdrawal.
 * Set to ₹500 to avoid trivially small bank transfers.
 */
const MIN_WITHDRAWAL_INR = 500;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Returns true if the user's 12-hour special offer window is still open. */
function isOfferValid(user) {
  const offer = user.specialOffer;
  if (!offer?.isActive) return false;
  if (!offer.expiresAt) return false;
  return new Date() < new Date(offer.expiresAt);
}

/**
 * Compute TDS and net payout from a gross withdrawal amount.
 *
 * @param {number} grossINR
 * @returns {{ grossINR, tdsINR, netINR, tdsRate, tdsPercent }}
 */
function computeTDS(grossINR) {
  const tdsINR  = Math.round(grossINR * TDS_RATE);
  const netINR  = grossINR - tdsINR;
  return {
    grossINR,
    tdsINR,
    netINR,
    tdsRate:    TDS_RATE,
    tdsPercent: `${(TDS_RATE * 100).toFixed(0)}%`,
  };
}

/** Total amount earned today (IST calendar day) counting pending + approved. */
async function getTodayEarnings(userId) {
  const now        = new Date();
  const istDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const startOfDayIST = new Date(`${istDateStr}T00:00:00+05:30`);

  const user = await User.findById(userId).select('lockedRewards').lean();
  return (user?.lockedRewards ?? [])
    .filter(r =>
      r.type === PAYOUT_TYPE &&
      ['pending', 'approved'].includes(r.status) &&
      new Date(r.createdAt) >= startOfDayIST
    )
    .reduce((sum, r) => sum + (r.amount || 0), 0);
}

/** Approved rewards available for use (not yet consumed or withdrawn). */
function getApprovedRewards(user) {
  return (user.lockedRewards ?? []).filter(
    r => r.type === PAYOUT_TYPE && r.status === 'approved'
  );
}

/** Total INR value of approved rewards. */
function sumApproved(user) {
  return getApprovedRewards(user).reduce((s, r) => s + (r.amount || 0), 0);
}

// ── GET /api/special-offer/status ────────────────────────────────────────────

exports.getStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('specialOffer lockedRewards')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    const offer = user.specialOffer;

    if (!offer?.isActive || !offer.expiresAt || new Date() >= new Date(offer.expiresAt)) {
      return res.json({
        isActive:      false,
        expiresIn:     0,
        expiresAt:     offer?.expiresAt ?? null,
        earned:        offer?.totalEarned ?? 0,
        referrals:     offer?.referralCount ?? 0,
        pendingCount:  0,
        approvedCount: 0,
        approvedINR:   0,
        todayEarned:   0,
        dailyCap:      DAILY_CAP_INR,
        canEarnMore:   false,
        tdsRate:       TDS_RATE,
      });
    }

    const expiresAt  = new Date(offer.expiresAt);
    const expiresIn  = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const rewards    = user.lockedRewards ?? [];

    const pendingCount  = rewards.filter(r => r.type === PAYOUT_TYPE && r.status === 'pending').length;
    const approvedCount = rewards.filter(r => r.type === PAYOUT_TYPE && r.status === 'approved').length;
    const approvedINR   = rewards
      .filter(r => r.type === PAYOUT_TYPE && r.status === 'approved')
      .reduce((s, r) => s + (r.amount || 0), 0);

    const todayEarned = await getTodayEarnings(user._id);
    const canEarnMore = todayEarned < DAILY_CAP_INR;

    return res.json({
      isActive:          true,
      expiresIn,
      expiresAt:         offer.expiresAt,
      startAt:           offer.startAt,
      earned:            offer.totalEarned ?? 0,
      referrals:         offer.referralCount ?? 0,
      pendingCount,
      approvedCount,
      approvedINR,
      todayEarned,
      dailyCap:          DAILY_CAP_INR,
      canEarnMore,
      rewardPerReferral: REWARD_PER_REFERRAL,
      tdsRate:           TDS_RATE,
      minWithdrawalINR:  MIN_WITHDRAWAL_INR,
    });
  } catch (err) {
    console.error('[specialOffer] getStatus error:', err);
    return res.status(500).json({ message: 'Failed to fetch offer status.' });
  }
};

// ── Internal: creditReferralReward ───────────────────────────────────────────
/**
 * Called by adminKycController.verifyKyc() when a referred user's KYC is approved.
 *
 * Credits ₹REWARD_PER_REFERRAL to the referrer's lockedRewards with
 * status 'pending'. An admin must approve each reward in the admin panel
 * before the user can either apply it to a subscription or withdraw it.
 *
 * This two-step (credit → admin approve → user redeems) design prevents
 * fraud farms from instantly cashing out referral rewards.
 *
 * @param {string|ObjectId} referrerId
 * @param {string|ObjectId} referredId
 * @returns {Promise<{ credited: boolean, reason?: string, amount?: number }>}
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

    // Duplicate guard: one reward per referred user
    const alreadyRewarded = (referrer.lockedRewards ?? []).some(
      r => r.referredUserId?.toString() === referredId.toString() && r.type === PAYOUT_TYPE
    );
    if (alreadyRewarded) {
      return { credited: false, reason: 'Already credited for this referral' };
    }

    // ── Trust & fraud scoring (non-blocking, best-effort) ────────────────────
    setImmediate(async () => {
      try {
        const [maResult, raResult] = await Promise.all([
          computeMultiAccountScore(referrerId, {}),
          computeReferralAbuseScore(referrerId),
        ]);
        if (maResult.tier !== 'clean' || raResult.score > 0.7) {
          await executeDefenseActions(
            referrerId, maResult, 'reward_claim',
            { specialOffer: true }, { referralAbuse: raResult.score }
          );
        }
      } catch (trustErr) {
        console.error('[specialOffer] trust check failed:', trustErr.message);
      }
    });

    // ── Credit the reward (status: 'pending' — requires admin approval) ───────
    const updated = await User.findByIdAndUpdate(
      referrerId,
      {
        $push: {
          lockedRewards: {
            amount:         REWARD_PER_REFERRAL,
            type:           PAYOUT_TYPE,
            status:         'pending',   // admin must approve before user can redeem
            referredUserId: referredId,
            createdAt:      new Date(),
          },
        },
        $inc: {
          'specialOffer.totalEarned':   REWARD_PER_REFERRAL,
          'specialOffer.referralCount': 1,
        },
      },
      { new: true }
    );

    if (!updated) return { credited: false, reason: 'Update failed' };

    // ── Create a pending Payout record so the admin panel shows it ────────────
    // The payout stays 'pending' until admin approves the lockedReward,
    // then the user chooses Path A (subscription) or Path B (withdrawal).
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
        panNumber:     updated.bankDetails?.panNumber     ?? null,
      },
      status:        'pending',   // admin approves → user picks redemption path
      userRequested: false,
      notes:         `Special offer referral credit — ₹${REWARD_PER_REFERRAL} for KYC approval of referred user ${referredId}. Pending admin review.`,
    }).catch(err =>
      console.error('[specialOffer] Payout.create failed (non-fatal):', err.message)
    );

    // ── Notify the referrer ───────────────────────────────────────────────────
    try {
      await Notification.create({
        user:    referrerId,
        type:    'referral_reward',
        message: `🎉 ₹${REWARD_PER_REFERRAL} Special Offer reward credited! Your referral just completed KYC. Pending admin review — you can apply it to your subscription or withdraw after approval.`,
        url:     '/rewards?tab=special',
      });

      getIO()
        .to(referrerId.toString())
        .emit('special_offer_reward', {
          amount:  REWARD_PER_REFERRAL,
          status:  'pending',
          message: `₹${REWARD_PER_REFERRAL} credited — awaiting admin approval`,
        });
    } catch (notifyErr) {
      console.debug('[specialOffer] notification failed (non-fatal):', notifyErr.message);
    }

    console.log(`[specialOffer] ✅ ₹${REWARD_PER_REFERRAL} credited (pending) to ${referrerId} for referring ${referredId}`);
    return { credited: true, amount: REWARD_PER_REFERRAL };

  } catch (err) {
    console.error('[specialOffer] creditReferralReward error:', err);
    return { credited: false, reason: err.message };
  }
};

// ── GET /api/special-offer/locked-rewards ────────────────────────────────────

exports.getLockedRewards = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('lockedRewards').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const rewards = (user.lockedRewards ?? [])
      .filter(r => r.type === PAYOUT_TYPE)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const approvedINR = rewards
      .filter(r => r.status === 'approved')
      .reduce((s, r) => s + (r.amount || 0), 0);

    const { tdsINR, netINR } = computeTDS(approvedINR);

    const summary = {
      total:                rewards.length,
      pending:              rewards.filter(r => r.status === 'pending').length,
      approved:             rewards.filter(r => r.status === 'approved').length,
      rejected:             rewards.filter(r => r.status === 'rejected').length,
      usedForSubscription:  rewards.filter(r => r.status === 'used_for_subscription').length,
      withdrawn:            rewards.filter(r => r.status === 'withdrawn').length,

      // Available for redemption (either path)
      approvedINR,

      // Path A (subscription) — full face value, no tax
      subscriptionCreditINR: approvedINR,

      // Path B (cash withdrawal) — net of TDS
      withdrawalGrossINR: approvedINR,
      withdrawalTdsINR:   tdsINR,
      withdrawalNetINR:   netINR,
      tdsRate:            TDS_RATE,
      tdsPercent:         `${(TDS_RATE * 100).toFixed(0)}%`,
      minWithdrawalINR:   MIN_WITHDRAWAL_INR,

      // Lifetime totals
      totalEarned: rewards
        .filter(r => r.status !== 'rejected')
        .reduce((s, r) => s + (r.amount || 0), 0),
      totalUsedForSubINR: rewards
        .filter(r => r.status === 'used_for_subscription')
        .reduce((s, r) => s + (r.amount || 0), 0),
      totalWithdrawnGrossINR: rewards
        .filter(r => r.status === 'withdrawn')
        .reduce((s, r) => s + (r.amount || 0), 0),
    };

    return res.json({ rewards, summary });
  } catch (err) {
    console.error('[specialOffer] getLockedRewards error:', err);
    return res.status(500).json({ message: 'Failed to fetch locked rewards.' });
  }
};

// ── GET /api/special-offer/withdrawal-preview ────────────────────────────────
/**
 * Returns a tax preview for the user BEFORE they commit to a cash withdrawal.
 * Shows gross amount, TDS deducted, and net amount they will receive.
 * No state is changed — purely informational.
 *
 * Response:
 *   { grossINR, tdsINR, netINR, tdsRate, tdsPercent, approvedCount,
 *     canWithdraw, reason?, bankDetailsRequired }
 */
exports.getWithdrawalPreview = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('lockedRewards kyc bankDetails trustFlags')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    const approvedRewards = getApprovedRewards(user);
    const grossINR        = approvedRewards.reduce((s, r) => s + (r.amount || 0), 0);
    const approvedCount   = approvedRewards.length;

    const tds = computeTDS(grossINR);

    // Determine eligibility and reason
    let canWithdraw = true;
    let reason      = null;

    if (user.kyc?.status !== 'verified') {
      canWithdraw = false;
      reason = 'KYC verification required before withdrawing rewards.';
    } else if (user.trustFlags?.rewardsFrozen) {
      canWithdraw = false;
      reason = 'Your reward payouts are temporarily suspended pending verification.';
    } else if (approvedCount === 0) {
      canWithdraw = false;
      reason = 'No approved rewards available. Rewards must be approved by admin before withdrawal.';
    } else if (grossINR < MIN_WITHDRAWAL_INR) {
      canWithdraw = false;
      reason = `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL_INR}. You have ₹${grossINR} approved.`;
    }

    return res.json({
      canWithdraw,
      reason,
      approvedCount,
      grossINR:             tds.grossINR,
      tdsINR:               tds.tdsINR,
      netINR:               tds.netINR,
      tdsRate:              tds.tdsRate,
      tdsPercent:           tds.tdsPercent,
      bankDetailsRequired:  !user.bankDetails?.accountNumber || !user.bankDetails?.ifscCode,
      // Subscription path is always tax-free (show for comparison)
      subscriptionCreditINR: grossINR,
      minWithdrawalINR:      MIN_WITHDRAWAL_INR,
    });
  } catch (err) {
    console.error('[specialOffer] getWithdrawalPreview error:', err);
    return res.status(500).json({ message: 'Failed to compute withdrawal preview.' });
  }
};

// ── POST /api/special-offer/request-withdrawal ───────────────────────────────
/**
 * PATH B — User requests a CASH WITHDRAWAL of their approved Special Offer rewards.
 *
 * Tax treatment:
 *   TDS at TDS_RATE (10%) is deducted from the gross approved amount.
 *   The NET amount (gross minus TDS) is what the admin pays to the user's bank.
 *   A separate TDS certificate line is recorded in the Payout notes.
 *
 * Flow:
 *   1. Validate KYC, bank details, approved balance, min threshold.
 *   2. Check for duplicate in-flight withdrawal request (idempotency).
 *   3. Mark all approved lockedRewards entries as 'withdrawn'.
 *   4. Compute gross, TDS, and net amounts.
 *   5. Create a Payout with status 'pending' for admin to process.
 *      → cashAmountINR = NET (what user receives after TDS)
 *      → tdsAmountINR stored in notes and breakdown for admin records
 *   6. Notify user and admin.
 *
 * The admin sees the Payout in their panel, processes the bank transfer of
 * the NET amount, and marks it 'paid'. TDS is deposited separately by the
 * platform to the Income Tax department.
 *
 * Body: { bankDetails?: { accountNumber, ifscCode, panNumber } }
 * Response: { success, payoutId, grossINR, tdsINR, netINR, tdsPercent, message }
 */
exports.requestWithdrawal = async (req, res) => {
  try {
    const userId      = req.user.id;
    const { bankDetails } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // ── KYC gate ──────────────────────────────────────────────────────────────
    if (user.kyc?.status !== 'verified') {
      return res.status(403).json({
        message: 'KYC verification is required before requesting a cash withdrawal.',
        code:    'KYC_REQUIRED',
      });
    }

    // ── Trust gate ────────────────────────────────────────────────────────────
    if (user.trustFlags?.rewardsFrozen) {
      return res.status(403).json({
        message: 'Your reward payouts are temporarily suspended pending verification.',
        code:    'REWARDS_FROZEN',
      });
    }

    // ── Find approved rewards ─────────────────────────────────────────────────
    const approvedRewards = getApprovedRewards(user);
    if (approvedRewards.length === 0) {
      return res.status(400).json({
        message: 'No approved Special Offer rewards available. Rewards must be approved by admin before withdrawal.',
        code:    'NO_APPROVED_REWARDS',
      });
    }

    const grossINR = approvedRewards.reduce((s, r) => s + (r.amount || 0), 0);

    if (grossINR < MIN_WITHDRAWAL_INR) {
      return res.status(400).json({
        message: `Minimum withdrawal is ₹${MIN_WITHDRAWAL_INR}. Your approved balance is ₹${grossINR}.`,
        code:    'BELOW_MINIMUM',
        grossINR,
        minimumINR: MIN_WITHDRAWAL_INR,
      });
    }

    // ── Idempotency: no duplicate pending withdrawal ───────────────────────────
    const existingPayout = await Payout.findOne({
      user:       userId,
      rewardType: PAYOUT_TYPE,
      status:     { $in: ['pending', 'processing', 'on_hold'] },
      // Distinguish withdrawal payouts from credit payouts (userRequested: true)
      userRequested: true,
    }).select('_id status cashAmountINR').lean();

    if (existingPayout) {
      return res.status(409).json({
        message: `A withdrawal request is already in progress (status: ${existingPayout.status}). Please wait for it to be processed.`,
        code:    'WITHDRAWAL_IN_PROGRESS',
        payoutId: String(existingPayout._id),
        netINR:   existingPayout.cashAmountINR,
      });
    }

    // ── Merge bank details if provided ────────────────────────────────────────
    if (bankDetails) {
      if (!user.bankDetails) user.bankDetails = {};
      if (bankDetails.accountNumber?.trim())
        user.bankDetails.accountNumber = bankDetails.accountNumber.trim();
      if (bankDetails.ifscCode?.trim())
        user.bankDetails.ifscCode = bankDetails.ifscCode.trim().toUpperCase();
      if (bankDetails.panNumber?.trim())
        user.bankDetails.panNumber = bankDetails.panNumber.trim().toUpperCase();
    }

    // ── Bank details required ─────────────────────────────────────────────────
    if (!user.bankDetails?.accountNumber || !user.bankDetails?.ifscCode) {
      return res.status(400).json({
        message: 'Bank account number and IFSC code are required to process a cash withdrawal.',
        code:    'BANK_DETAILS_REQUIRED',
      });
    }

    // ── Compute TDS ───────────────────────────────────────────────────────────
    const tds = computeTDS(grossINR);

    // ── Mark all approved rewards as 'withdrawn' atomically ───────────────────
    user.lockedRewards = (user.lockedRewards ?? []).map(r => {
      if (r.type === PAYOUT_TYPE && r.status === 'approved') {
        return {
          ...( r.toObject?.() ?? r ),
          status:      'withdrawn',
          withdrawnAt: new Date(),
        };
      }
      return r;
    });
    await user.save();

    // ── Bank details snapshot ─────────────────────────────────────────────────
    const bankSnapshot = {
      accountNumber: user.bankDetails.accountNumber,
      ifscCode:      user.bankDetails.ifscCode,
      panNumber:     user.bankDetails.panNumber ?? null,
    };

    const now = new Date();

    // ── Create Payout record (pending — admin disburses net amount) ───────────
    //   cashAmountINR  = NET amount (after TDS) — what admin pays to user's bank
    //   tdsAmountINR   = TDS amount — platform deposits to Income Tax Dept
    //   grossAmountINR = Total approved (gross) before deduction
    //   Notes carry full tax breakdown for admin & audit trail.
    const payout = await Payout.create({
      user:          userId,
      rewardType:    PAYOUT_TYPE,
      milestone:     `special_offer_withdrawal_${now.getTime()}`,
      planKey:       user.subscription?.planAmount
        ? String(user.subscription.planAmount)
        : '2500',
      breakdown: {
        groceryCoupons: tds.netINR,   // net amount credited to user
        shares:         0,
        referralToken:  0,
      },
      // cashAmountINR is the NET the user receives (gross - TDS)
      cashAmountINR:  tds.netINR,
      totalAmountINR: tds.netINR,
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
      bankDetails:    bankSnapshot,
      status:         'pending',   // admin processes bank transfer and marks 'paid'
      userRequested:  true,
      notes: [
        `Special Offer Cash Withdrawal Request`,
        `Gross amount: ₹${tds.grossINR}`,
        `TDS deducted (${tds.tdsPercent} under Section 194R): ₹${tds.tdsINR}`,
        `NET payable to user: ₹${tds.netINR}`,
        `Rewards withdrawn: ${approvedRewards.length} entries`,
        `Bank: ${bankSnapshot.ifscCode} | Acct: ****${bankSnapshot.accountNumber.slice(-4)}`,
        `Requested at: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
      ].join('\n'),
    });

    // ── Notify user ───────────────────────────────────────────────────────────
    try {
      await Notification.create({
        user:    userId,
        type:    'custom',
        message: `💸 Withdrawal request submitted! Gross: ₹${tds.grossINR} | TDS (${tds.tdsPercent}): ₹${tds.tdsINR} | You receive: ₹${tds.netINR}. Admin will process within 2–5 business days.`,
        url:     '/rewards?tab=special',
      });

      getIO()
        .to(userId.toString())
        .emit('special_offer_withdrawal_requested', {
          grossINR:   tds.grossINR,
          tdsINR:     tds.tdsINR,
          netINR:     tds.netINR,
          tdsPercent: tds.tdsPercent,
          payoutId:   payout._id.toString(),
        });
    } catch (notifyErr) {
      console.debug('[specialOffer] user notification failed (non-fatal):', notifyErr.message);
    }

    // ── Notify admin room ─────────────────────────────────────────────────────
    try {
      getIO()
        .to('admin_room')
        .emit('special_offer_withdrawal_requested', {
          userId:     userId.toString(),
          userName:   user.name || user.username,
          grossINR:   tds.grossINR,
          tdsINR:     tds.tdsINR,
          netINR:     tds.netINR,
          tdsPercent: tds.tdsPercent,
          payoutId:   payout._id.toString(),
          requestedAt: now,
        });
    } catch (sockErr) {
      console.debug('[specialOffer] admin socket notify failed (non-fatal):', sockErr.message);
    }

    console.log(
      `[specialOffer] ✅ Withdrawal request: user=${userId} gross=₹${tds.grossINR} ` +
      `tds=₹${tds.tdsINR} net=₹${tds.netINR} payout=${payout._id}`
    );

    return res.status(201).json({
      success:     true,
      message:     `Withdrawal request submitted. You will receive ₹${tds.netINR} (after ₹${tds.tdsINR} TDS at ${tds.tdsPercent}) within 2–5 business days.`,
      payoutId:    payout._id,
      grossINR:    tds.grossINR,
      tdsINR:      tds.tdsINR,
      netINR:      tds.netINR,
      tdsPercent:  tds.tdsPercent,
      tdsNote:     `TDS of ${tds.tdsPercent} is deducted under Income Tax Act Section 194R. A TDS certificate will be provided.`,
      requestedAt: now,
    });

  } catch (err) {
    console.error('[specialOffer] requestWithdrawal error:', err);
    return res.status(500).json({ message: 'Failed to submit withdrawal request.' });
  }
};

// ── POST /api/special-offer/withdraw (kept for backward compat) ──────────────
// Alias — redirects to requestWithdrawal so existing frontend callers still work.
exports.withdraw = exports.requestWithdrawal;