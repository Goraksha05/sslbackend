/**
 * routes/redeemGrocery.js
 *
 * POST /api/activity/redeem-grocery-coupons
 *
 * Allows a verified, subscribed user to request cash redemption of their
 * accumulated grocery coupons.
 *
 * WHAT IT DOES:
 *   1. Validates eligibility (KYC verified, active subscription, balance > 0,
 *      rewards not frozen, no pending redemption already in flight).
 *   2. Updates user bank details if provided (upserts, never overwrites with null).
 *   3. Creates a RewardClaim of type 'grocery_redeem' to act as the paper trail.
 *   4. Creates a Payout document (status: 'pending') so admins see it immediately
 *      in the RewardPayout admin panel.
 *   5. Notifies every admin / super_admin who has the 'manage_payouts' permission
 *      via three channels: DB notification, Socket.IO (admin_room), and Web Push.
 *   6. Returns a structured response the frontend can use to update the UI.
 *
 * MOUNT IN index.js (inside the protected apiLimiter block, NOT the admin router):
 *   app.use('/api/activity', require('./routes/redeemGrocery'));
 *
 * Or if activity.js is already a file-based router, add the route there:
 *   router.post('/redeem-grocery-coupons', fetchUser, requireRewardEligibility, handler);
 *
 * ADMIN NOTIFICATION CHANNELS:
 *   • Notification model  — persists for admin notification bell
 *   • Socket.IO           — emitted to 'admin_room' for real-time dashboard update
 *   • Web Push            — sent to every admin with a PushSubscription
 *
 * IDEMPOTENCY:
 *   The route prevents duplicate "in-flight" redemptions by checking for an
 *   existing Payout document in 'pending' or 'processing' state for the same
 *   user.  A user can submit a new redemption only after their previous one
 *   reaches 'paid' or 'failed'.
 */

'use strict';

const express   = require('express');
const router    = express.Router();

const User           = require('../models/User');
const Notification   = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const RewardClaim    = require('../models/RewardClaim');
const Payout         = require('../models/PayoutSchema');

const fetchUser               = require('../middleware/fetchuser');
const requireRewardEligibility = require('../middleware/requireRewardEligibility');

const { getIO }         = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser         = require('../utils/notifyUser');
const rn = require('../services/rewardNotificationService');
// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_BALANCE = 500;         // minimum ₹ balance required to trigger redemption
const SHARE_VAL   = 1;         // ₹ per share unit   (mirrors financeAndPayoutController)
const TOKEN_VAL   = 1;         // ₹ per referral token

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n) {
  return `₹${(n ?? 0).toLocaleString('en-IN')}`;
}

/**
 * Merge incoming bank detail fields onto the user document.
 * Only overwrites a field when the incoming value is non-empty.
 */
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

/**
 * Fetch all admin users who have the 'manage_payouts' permission.
 * Returns a lean array of { _id, name, email, role, adminPermissions }.
 *
 * We check:
 *   • role === 'super_admin'          — always has all permissions (wildcard)
 *   • role === 'admin' AND (
 *       adminPermissions includes 'manage_payouts'  OR
 *       adminRole.permissions includes 'manage_payouts'
 *     )
 */
async function fetchPayoutAdmins() {
  const AdminRole = require('../models/AdminRole');

  // Load all admin roles that contain 'manage_payouts'
  const rolesWithPerm = await AdminRole.find({
    permissions: 'manage_payouts',
  }).select('_id').lean();

  const roleIds = rolesWithPerm.map(r => r._id);

  const admins = await User.find({
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
  })
    .select('_id name email role')
    .lean();

  return admins;
}

/**
 * Fire notifications to all payout-eligible admins (non-blocking).
 * Failures here must never abort the user-facing response.
 */
// async function notifyAdmins(userId, userName, amount, payoutId) {
//   let admins = [];
//   try {
//     admins = await fetchPayoutAdmins();
//   } catch (err) {
//     console.error('[redeemGrocery] fetchPayoutAdmins failed:', err.message);
//     return;
//   }

//   if (!admins.length) {
//     console.warn('[redeemGrocery] No admins with manage_payouts found — notification skipped.');
//     return;
//   }

//   const message =
//     `💳 ${userName} has requested grocery coupon redemption of ${fmtINR(amount)}. ` +
//     `Please review and process the payout in Admin → Reward Payouts.`;

//   const pushPayload = {
//     title:   '💳 New Grocery Redemption Request',
//     message: `${userName} requested ${fmtINR(amount)} payout. Tap to review.`,
//     url:     '/admin/financial?tab=claims',
//   };

//   await Promise.allSettled(
//     admins.map(async (admin) => {
//       const adminId = admin._id.toString();
//       try {
//         // 1. DB notification (admin notification bell)
//         await Notification.create({
//           user:    admin._id,
//           sender:  userId,
//           type:    'custom',
//           message,
//           url:     '/admin/financial?tab=claims',
//         });

//         // 2. Real-time socket → admin_room broadcast + personal room
//         try {
//           const io = getIO();
//           // Broadcast to the shared admin_room (RewardPayout panel listens here)
//           io.to('admin_room').emit('payout:new_request', {
//             payoutId:   payoutId.toString(),
//             userId:     userId.toString(),
//             userName,
//             amount,
//             type:       'grocery_redeem',
//             requestedAt: new Date(),
//           });
//           // Also emit to admin's personal room so their notification bell updates
//           io.to(adminId).emit('notification', {
//             type:    'custom',
//             message,
//             url:     '/admin/financial?tab=claims',
//             createdAt: new Date(),
//           });
//         } catch (sockErr) {
//           // Socket not ready or admin offline — fine, DB + push cover it
//           console.debug(`[redeemGrocery] Socket skipped for admin ${adminId}: ${sockErr.message}`);
//         }

//         // 3. Web Push
//         await sendPushToUser(adminId, pushPayload);

//       } catch (err) {
//         console.error(`[redeemGrocery] Notification failed for admin ${adminId}:`, err.message);
//         // Continue to other admins
//       }
//     })
//   );

//   console.log(
//     `[redeemGrocery] ✅ Notified ${admins.length} admin(s) about redemption of ${fmtINR(amount)} by ${userName}`
//   );
// }

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/activity/redeem-grocery-coupons
 *
 * Body (all optional unless user has no bank details on file):
 *   bankDetails  { accountNumber, ifscCode, panNumber }
 *   notes        string   — admin-facing note from user
 */
router.post(
  '/redeem-grocery-coupons',
  fetchUser,
  requireRewardEligibility,   // ensures KYC verified + active subscription + not frozen
  async (req, res) => {
    const { bankDetails, notes } = req.body;

    try {
      // ── 1. Load fresh user document ─────────────────────────────────────────
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ message: 'User not found.', code: 'USER_NOT_FOUND' });
      }

      // ── 2. Balance guard ────────────────────────────────────────────────────
      const balance = user.totalGroceryCoupons ?? 0;
      if (balance < MIN_BALANCE) {
        return res.status(400).json({
          message: `You need at least ${fmtINR(MIN_BALANCE)} in grocery coupons to redeem. Your current balance is ${fmtINR(balance)}.`,
          code: 'INSUFFICIENT_BALANCE',
        });
      }

      // ── 3. Idempotency guard — no duplicate pending redemptions ─────────────
      // Look for an existing Payout of type 'grocery_redeem' in a non-terminal state.
      const existingPayout = await Payout.findOne({
        user:       user._id,
        rewardType: 'grocery_redeem',
        status:     { $in: ['pending', 'processing', 'on_hold'] },
      }).lean();

      if (existingPayout) {
        return res.status(409).json({
          message:
            `You already have a redemption request in progress (status: ${existingPayout.status}). ` +
            `Please wait for it to be processed before submitting a new request.`,
          code: 'REDEMPTION_ALREADY_PENDING',
          existingPayoutId: String(existingPayout._id),
        });
      }

      // ── 4. Bank details guard ───────────────────────────────────────────────
      const hasBankDetails =
        !!user.bankDetails?.accountNumber && !!user.bankDetails?.ifscCode;

      if (!hasBankDetails && !bankDetails) {
        return res.status(400).json({
          message: 'Bank account details are required to process the redemption. Please provide your account number, IFSC code, and PAN.',
          code: 'BANK_DETAILS_REQUIRED',
        });
      }

      // Validate incoming bank details if provided
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

      // ── 5. Create RewardClaim (paper trail) ────────────────────────────────
      // Use a custom milestone string that encodes the amount for easy admin lookup.
      const milestoneParts = `${balance}_groceryCoupons`;

      let rewardClaim;
      try {
        rewardClaim = await RewardClaim.create({
          user:      user._id,
          type:      'grocery_redeem',
          milestone: milestoneParts,
        });
      } catch (claimErr) {
        // Unique index violation — another concurrent request just created the claim
        if (claimErr.code === 11000) {
          return res.status(409).json({
            message: 'A redemption request was already submitted. Please wait for it to be processed.',
            code: 'REDEMPTION_ALREADY_PENDING',
          });
        }
        throw claimErr;
      }

      // ── 6. Create Payout document (admin panel picks this up) ──────────────
      const bankSnapshot = {
        accountNumber: user.bankDetails?.accountNumber || null,
        ifscCode:      user.bankDetails?.ifscCode      || null,
        panNumber:     user.bankDetails?.panNumber      || null,
      };

      const totalAmountINR = balance;   // grocery coupons are already in ₹

      const payout = await Payout.create({
        user:          user._id,
        rewardClaim:   rewardClaim._id,
        rewardType:    'grocery_redeem',
        milestone:     milestoneParts,
        planKey:       user.subscription?.planAmount
          ? String(user.subscription.planAmount)
          : '2500',
        breakdown: {
          groceryCoupons: balance,
          shares:         0,
          referralToken:  0,
        },
        totalAmountINR,
        bankSnapshot,
        status:  'pending',
        notes:   notes
          ? `User note: ${notes}`
          : `Grocery coupon redemption request — ${fmtINR(balance)} — submitted ${new Date().toLocaleDateString('en-IN')}`,
      });
      rn.notifyGroceryRedemptionSubmitted({
        userId:    user._id,
        userName:  user.name || user.username,
        amountINR: balance,
        payoutId:  payout._id,
      }).catch(err => console.warn('[notify]', err.message));

      // ── 7. Persist updated bank details + save ──────────────────────────────
      await user.save();

      // ── 8. Notify admins (fire-and-forget — never blocks response) ─────────
      // notifyAdmins(
      //   user._id,
      //   user.name || user.username || 'A user',
      //   balance,
      //   payout._id
      // ).catch(err =>
      //   console.error('[redeemGrocery] notifyAdmins fire-and-forget failed:', err.message)
      // );

      // ── 9. Respond ──────────────────────────────────────────────────────────
      console.log(
        `[redeemGrocery] ✅ Redemption request created: user=${user._id} amount=${fmtINR(balance)} payout=${payout._id}`
      );

      return res.status(201).json({
        success:        true,
        message:        `Your grocery coupon redemption of ${fmtINR(balance)} has been submitted. The finance team will process it within 3–5 working days.`,
        payoutId:       payout._id,
        rewardClaimId:  rewardClaim._id,
        amount:         balance,
        status:         'pending',
      });

    } catch (err) {
      console.error('[POST /redeem-grocery-coupons]', err);
      return res.status(500).json({
        message: 'Server error while processing your redemption request. Please try again.',
        code: 'SERVER_ERROR',
      });
    }
  }
);

module.exports = router;
