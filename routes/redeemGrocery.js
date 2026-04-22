/**
 * routes/redeemGrocery.js
 *
 * POST /api/activity/redeem-grocery-coupons
 * GET  /api/activity/redemption-status
 * DELETE /api/activity/redemption-cancel
 *
 * User-initiated grocery coupon redemption flow.
 *
 * FLOW:
 *   User Panel  →  POST /redeem-grocery-coupons  →  Payout(status:'pending')
 *   Admin Panel →  sees it in "Pending Claims" tab (rewardType:'grocery_redeem')
 *   Admin pays  →  PATCH /api/admin/payouts/:id/status → status:'paid'
 *   Admin ONLY pays what users explicitly requested.
 *
 * WHAT CHANGED vs original:
 *   - cashAmountINR field is now set on Payout (was only totalAmountINR before)
 *   - objectRewardsHeld set to zero (grocery redemption is pure cash)
 *   - redemption-status endpoint added so User Panel can poll current state
 *   - redemption-cancel endpoint added so user can cancel a 'pending' request
 *   - userRequested flag added to Payout so admin can distinguish
 *     user-initiated vs admin-initiated payouts
 */

'use strict';

const express = require('express');
const router  = express.Router();

const User        = require('../models/User');
const RewardClaim = require('../models/RewardClaim');
const Payout      = require('../models/PayoutSchema');

const fetchUser                = require('../middleware/fetchuser');
const requireRewardEligibility = require('../middleware/requireRewardEligibility');
const rn = require('../services/rewardNotificationService');

// ── Constants ──────────────────────────────────────────────────────────────────
const MIN_BALANCE = 500; // minimum ₹ balance to trigger redemption

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtINR(n) {
  return `₹${(n ?? 0).toLocaleString('en-IN')}`;
}

function mergeBankDetails(user, bankDetails) {
  if (!bankDetails) return;
  if (!user.bankDetails) user.bankDetails = {};
  if (bankDetails.accountNumber?.trim())
    user.bankDetails.accountNumber = bankDetails.accountNumber.trim();
  if (bankDetails.ifscCode?.trim())
    user.bankDetails.ifscCode = bankDetails.ifscCode.trim().toUpperCase();
  if (bankDetails.panNumber?.trim())
    user.bankDetails.panNumber = bankDetails.panNumber.trim().toUpperCase();
}

// ── POST /api/activity/redeem-grocery-coupons ─────────────────────────────────
router.post(
  '/redeem-grocery-coupons',
  fetchUser,
  requireRewardEligibility,
  async (req, res) => {
    const { bankDetails, notes } = req.body;

    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ message: 'User not found.', code: 'USER_NOT_FOUND' });
      }

      // ── Balance guard ──────────────────────────────────────────────────────
      // COMPUTE available balance (ledger model)
      const earned   = user.totalGroceryCoupons  ?? 0;
      const redeemed = user.totalRedeemedGrocery ?? 0;
      const balance  = earned - redeemed;

      if (balance < MIN_BALANCE) {
        return res.status(400).json({
          message: `Minimum ${fmtINR(MIN_BALANCE)} required to redeem. Your balance: ${fmtINR(balance)}.`,
          code: 'INSUFFICIENT_BALANCE',
          balance,
          minimumRequired: MIN_BALANCE,
        });
      }

      // ── Idempotency — no duplicate in-flight redemptions ───────────────────
      const existingPayout = await Payout.findOne({
        user:       user._id,
        rewardType: 'grocery_redeem',
        status:     { $in: ['pending', 'processing', 'on_hold'] },
      }).select('_id status totalAmountINR createdAt').lean();

      if (existingPayout) {
        return res.status(409).json({
          message:
            `You already have a redemption request in progress (status: ${existingPayout.status}). ` +
            `Wait for it to be processed before submitting a new request.`,
          code: 'REDEMPTION_ALREADY_PENDING',
          existingPayoutId:     String(existingPayout._id),
          existingPayoutStatus: existingPayout.status,
          existingAmount:       existingPayout.totalAmountINR,
        });
      }

      // ── Bank details ───────────────────────────────────────────────────────
      if (bankDetails) {
        if (bankDetails.accountNumber && !/^\d{9,18}$/.test(bankDetails.accountNumber)) {
          return res.status(400).json({ message: 'Invalid bank account number.', code: 'INVALID_BANK_DETAILS' });
        }
        if (bankDetails.ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(bankDetails.ifscCode)) {
          return res.status(400).json({ message: 'Invalid IFSC code.', code: 'INVALID_BANK_DETAILS' });
        }
        if (bankDetails.panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(bankDetails.panNumber)) {
          return res.status(400).json({ message: 'Invalid PAN number.', code: 'INVALID_BANK_DETAILS' });
        }
        mergeBankDetails(user, bankDetails);
      }

      const hasBankDetails = !!(user.bankDetails?.accountNumber && user.bankDetails?.ifscCode);
      if (!hasBankDetails) {
        return res.status(400).json({
          message: 'Bank account details required. Please provide your account number and IFSC code.',
          code: 'BANK_DETAILS_REQUIRED',
        });
      }

      // ── ATOMIC DEBIT: increment totalRedeemedGrocery ───────────────────────────
      const updatedUser = await User.findOneAndUpdate(
        {
          _id: user._id,
          // Guard: ensure (earned - redeemed) is still >= balance at the moment of write
          // Equivalent: totalGroceryCoupons - totalRedeemedGrocery >= balance
          // Rearranged: totalGroceryCoupons >= totalRedeemedGrocery + balance
          $expr: {
            $gte: [
              '$totalGroceryCoupons',
              { $add: [{ $ifNull: ['$totalRedeemedGrocery', 0] }, balance] },
            ],
          },
        },
        {
          $inc: { totalRedeemedGrocery: balance },
          // Also persist any bank detail changes
          $set: { bankDetails: user.bankDetails },
        },
        { new: true }
      );

      if (!updatedUser) {
        // Race condition: another concurrent redemption was processed between our
        // read and this write. Reject cleanly.
        return res.status(409).json({
          message: 'Your balance changed while processing. Please try again.',
          code: 'CONCURRENT_REDEMPTION',
        });
      }

      // ── Create RewardClaim (audit trail) ───────────────────────────────────
      const milestoneKey = `${balance}_groceryCoupons`;
      let rewardClaim;
      try {
        rewardClaim = await RewardClaim.create({
          user:      user._id,
          type:      'grocery_redeem',
          milestone: milestoneKey,
        });
      } catch (claimErr) {
        if (claimErr.code === 11000) {
          return res.status(409).json({
            message: 'A redemption request was already submitted. Please wait for processing.',
            code: 'REDEMPTION_ALREADY_PENDING',
          });
        }
        throw claimErr;
      }

      // ── Bank snapshot at time of request ───────────────────────────────────
      const bankSnapshot = {
        accountNumber: user.bankDetails?.accountNumber || null,
        ifscCode:      user.bankDetails?.ifscCode      || null,
        panNumber:     user.bankDetails?.panNumber      || null,
      };

      // ── Create Payout document ──────────────────────────────────────────────
      // userRequested: true flags this as user-initiated so admin knows to pay it.
      // Admin-initiated payouts (slab rewards) set userRequested: false.
      const payout = await Payout.create({
        user:          user._id,
        rewardClaim:   rewardClaim._id,
        rewardType:    'grocery_redeem',
        milestone:     milestoneKey,
        planKey:       user.subscription?.planAmount
          ? String(user.subscription.planAmount)
          : '2500',
        breakdown: {
          groceryCoupons: balance,
          shares:         0,
          referralToken:  0,
        },
        // CASH payout — grocery coupons are ₹ face value
        cashAmountINR:     balance,
        totalAmountINR:    balance,
        objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
        bankDetails:       bankSnapshot,
        status:            'pending',
        userRequested:     true,   // key flag: admin should pay this
        notes: notes
          ? `User note: ${notes}`
          : `User-requested grocery redemption — ${fmtINR(balance)} — ${new Date().toLocaleDateString('en-IN')}`,
      });

      // ── Persist bank detail updates ─────────────────────────────────────────
      await user.save();

      // ── Notify admins (fire-and-forget) ────────────────────────────────────
      rn.notifyGroceryRedemptionSubmitted({
        userId:    user._id,
        userName:  user.name || user.username,
        amountINR: balance,
        payoutId:  payout._id,
      }).catch(err => console.warn('[redeemGrocery] notify failed:', err.message));

      console.log(
        `[redeemGrocery] ✅ user=${user._id} amount=${fmtINR(balance)} payout=${payout._id}`
      );

      const newEarned   = updatedUser.totalGroceryCoupons   ?? 0;
      const newRedeemed = updatedUser.totalRedeemedGrocery  ?? 0;

      return res.status(201).json({
        success:       true,
        message:       `Your redemption of ${fmtINR(balance)} has been submitted. ...`,
        payoutId:      payout._id,
        rewardClaimId: rewardClaim._id,
        amount:        balance,
        status:        'pending',
        submittedAt:   payout.createdAt,
        // ← NEW: wallet snapshot so the frontend can update without a second fetch
        wallet: {
          totalEarned:     newEarned,
          totalRedeemed:   newRedeemed,
          availableBalance: newEarned - newRedeemed,
        },
      });

    } catch (err) {
      console.error('[POST /redeem-grocery-coupons]', err);
      return res.status(500).json({
        message: 'Server error while processing your request. Please try again.',
        code: 'SERVER_ERROR',
      });
    }
  }
);

// ── GET /api/activity/redemption-status ───────────────────────────────────────
// Returns the user's most recent grocery redemption payout (if any).
// User Panel uses this to show the current redemption status card.
router.get('/redemption-status', fetchUser, async (req, res) => {
  try {
    const payout = await Payout.findOne({
      user:       req.user.id,
      rewardType: 'grocery_redeem',
    })
      .sort({ createdAt: -1 })
      .select('status totalAmountINR cashAmountINR createdAt paidAt transactionRef failureReason notes userRequested')
      .lean();

    if (!payout) {
      return res.json({ hasRedemption: false });
    }

    return res.json({
      hasRedemption: true,
      payoutId:      payout._id,
      status:        payout.status,
      amount:        payout.cashAmountINR ?? payout.totalAmountINR ?? 0,
      submittedAt:   payout.createdAt,
      paidAt:        payout.paidAt || null,
      transactionRef: payout.transactionRef || null,
      failureReason:  payout.failureReason  || null,
      canRequestNew:  ['paid', 'failed'].includes(payout.status),
    });
  } catch (err) {
    console.error('[GET /redemption-status]', err);
    return res.status(500).json({ message: 'Failed to fetch redemption status.' });
  }
});

// ── DELETE /api/activity/redemption-cancel ────────────────────────────────────
// Allows user to cancel a 'pending' redemption before admin processes it.
router.delete('/redemption-cancel', fetchUser, async (req, res) => {
  try {
    const payout = await Payout.findOne({
      user:       req.user.id,
      rewardType: 'grocery_redeem',
      status:     'pending',   // can only cancel if still pending (not yet picked up)
    });

    if (!payout) {
      return res.status(404).json({
        message: 'No cancellable redemption request found. Requests in processing or paid state cannot be cancelled.',
        code: 'NOT_CANCELLABLE',
      });
    }

    payout.status = 'failed';
    payout.failureReason = 'Cancelled by user';
    payout.notes = `${payout.notes}\nCancelled by user on ${new Date().toLocaleDateString('en-IN')}`;
    await payout.save();

    return res.json({
      success: true,
      message: 'Your redemption request has been cancelled.',
      payoutId: payout._id,
    });
  } catch (err) {
    console.error('[DELETE /redemption-cancel]', err);
    return res.status(500).json({ message: 'Failed to cancel redemption request.' });
  }
});

module.exports = router;