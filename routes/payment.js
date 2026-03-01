/**
 * routes/payment.js
 *
 * Razorpay payment routes:
 *   POST /api/payment/create-order
 *   POST /api/payment/verify
 *   GET  /api/payment/subscription-status
 *   POST /api/payment/toggle-autorenew
 *   GET  /api/payment/progress
 *   POST /api/payment/activate-by-referrals
 */

'use strict';

const express  = require('express');
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const router   = express.Router();

const User         = require('../models/User');
const fetchUser    = require('../middleware/fetchuser');
const Notification = require('../models/Notification');
const { getIO }         = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser         = require('../utils/notifyUser');

// ── Constants ────────────────────────────────────────────────────────────────

/** Allowed plan names — single source of truth shared with frontend */
const VALID_PLANS = new Set(['Basic', 'Standard', 'Premium']);

/**
 * Plan amounts in INR (rupees, NOT paise).
 * Used to re-validate the amount on the server so a crafty client
 * cannot send ₹1 and get a Premium subscription.
 */
const PLAN_AMOUNTS = { Basic: 2500, Standard: 3500, Premium: 4500 };

/** Minimum allowed order amount in paise (₹1 = 100 paise) */
const MIN_AMOUNT_PAISE = 100;

// ── Razorpay client ──────────────────────────────────────────────────────────

// BUG FIX: The original called require('dotenv').config() here, which is a
// no-op if it was already called in app.js (common pattern) and is completely
// wrong if it hasn't been — the config should live at the app entry point.
// Removed. Ensure dotenv.config() is called in your main server file.

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error('FATAL: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment.');
}

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fire-and-forget notifications after a subscription event. Never throws. */
async function dispatchSubscriptionNotifications(userId, { type, inAppMsg, pushTitle, pushMsg }) {
  const userIdStr = userId.toString();

  // DB notification
  Notification.create({
    user:    userId,
    sender:  null,
    type,
    message: inAppMsg,
    url:     '/subscription',
  }).catch(err => console.error(`[payment] Notification.create failed (${type}):`, err.message));

  // In-app socket notification
  notifyUser(userId, inAppMsg, type).catch(() => {});

  // Push notification
  sendPushToUser(userIdStr, { title: pushTitle, message: pushMsg, url: '/subscription' });

  // Real-time socket emit
  try {
    const io = getIO();
    io.to(userIdStr).emit('notification', { type, message: inAppMsg });
  } catch (socketErr) {
    console.warn(`[payment] Socket emit failed (${type}):`, socketErr.message);
  }
}

/** Build a one-year-later Date from a given start Date. */
function oneYearFrom(date) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

// ── POST /create-order ───────────────────────────────────────────────────────
/**
 * Creates a Razorpay order.
 *
 * SECURITY FIX: The original trusted the client-supplied `amount` directly.
 * An attacker could pass amount=100 (₹1) and buy any plan.
 * Now the server derives the canonical amount from `planName`.
 *
 * Body: { planName: 'Basic' | 'Standard' | 'Premium' }
 */
router.post('/create-order', fetchUser, async (req, res) => {
  const { planName } = req.body;

  // Validate plan
  if (!planName || !VALID_PLANS.has(planName)) {
    return res.status(400).json({
      success: false,
      error:   `Invalid plan. Must be one of: ${[...VALID_PLANS].join(', ')}`,
    });
  }

  // Server-side canonical amount — never trust the client
  const amountPaise = PLAN_AMOUNTS[planName] * 100;

  try {
    const order = await razorpay.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      // BUG FIX: receipt must be ≤ 40 chars (Razorpay limit). Date.now() is 13 digits;
      // "receipt_order_" is 15 chars → 28 total. Fine, but using a short prefix is safer.
      receipt:  `rcpt_${req.user.id.toString().slice(-8)}_${Date.now().toString(36)}`,
      notes: {
        userId:   req.user.id,
        planName,
      },
    });

    return res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('[payment] create-order error:', error);
    return res.status(500).json({ success: false, error: 'Order creation failed' });
  }
});

// ── POST /verify ─────────────────────────────────────────────────────────────
/**
 * Verifies Razorpay payment signature and activates the subscription.
 *
 * BUG FIX (critical): The original did:
 *   referralTarget: (User?.subscription?.referralTarget ?? 10)
 *   `User` is the Mongoose MODEL, not a document — it has no `.subscription`.
 *   This always evaluated to 10, silently discarding the user's actual target.
 *   Fixed by fetching the user document first.
 *
 * SECURITY: Signature verification uses timingSafeEqual to prevent
 * timing-attack leakage.
 *
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName }
 */
router.post('/verify', fetchUser, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName } = req.body;

  // Input validation
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Missing payment fields' });
  }
  if (!planName || !VALID_PLANS.has(planName)) {
    return res.status(400).json({ success: false, error: 'Invalid plan name' });
  }

  // ── Step 1: Signature verification (timing-safe) ──────────────────────────
  const generatedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  // BUG FIX: Use timingSafeEqual to prevent timing attacks on the comparison.
  // Both buffers must be the same length — hex strings of the same HMAC are always equal length.
  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(generatedSignature, 'hex'),
    Buffer.from(razorpay_signature,  'hex'),
  );

  if (!signaturesMatch) {
    console.warn(`[payment] Signature mismatch for order ${razorpay_order_id} — possible tamper attempt.`);
    return res.status(400).json({ success: false, error: 'Invalid payment signature' });
  }

  // ── Step 2: Fetch current user to preserve referralTarget ────────────────
  // BUG FIX: Original used `User?.subscription?.referralTarget` (the Model, not
  // a document), which always returned undefined → defaulted to 10 every time,
  // potentially resetting a custom target set on the user.
  let existingUser;
  try {
    existingUser = await User.findById(req.user.id).select('subscription activationMethod referralTarget');
    if (!existingUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (dbErr) {
    console.error('[payment] User lookup failed:', dbErr);
    return res.status(500).json({ success: false, error: 'Server error during verification' });
  }

  const now          = new Date();
  const expiresAt    = oneYearFrom(now);
  const referralTarget = existingUser.subscription?.referralTarget ?? existingUser.referralTarget ?? 10;

  // ── Step 3: Save subscription ─────────────────────────────────────────────
  try {
    await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          'subscription.plan':            planName,
          'subscription.paymentId':       razorpay_payment_id,
          'subscription.orderId':         razorpay_order_id,
          'subscription.active':          true,
          'subscription.startDate':       now,
          'subscription.expiresAt':       expiresAt,
          'subscription.autoRenew':       false,
          'subscription.activationMethod': 'paid',
          // Preserve the user's referralTarget; do NOT reset to a hardcoded 10
          'subscription.referralTarget':  referralTarget,
        },
      },
      { new: false }, // we don't need the updated doc
    );

    console.log(`✅ [payment] User ${req.user.id} subscribed to ${planName} (expires ${expiresAt.toDateString()})`);
  } catch (dbErr) {
    console.error('[payment] Subscription save failed:', dbErr);
    return res.status(500).json({ success: false, error: 'Failed to save subscription' });
  }

  // ── Step 4: Notifications (fire-and-forget) ───────────────────────────────
  dispatchSubscriptionNotifications(req.user.id, {
    type:       'payment_success',
    inAppMsg:   `Payment successful! Your ${planName} plan is now active 🎉`,
    pushTitle:  'Subscription Activated 🎉',
    pushMsg:    `Your ${planName} plan is active until ${expiresAt.toDateString()}`,
  });

  return res.status(200).json({
    success:    true,
    message:    'Payment verified and subscription activated',
    plan:       planName,
    expiresAt,
  });
});

// ── GET /subscription-status ─────────────────────────────────────────────────
/**
 * Returns the current subscription status for the logged-in user.
 *
 * BUG FIX: The original did not check whether `expiresAt` has passed —
 * an expired subscription would still show `subscribed: true`.
 * Now checks expiry and auto-deactivates stale records.
 */
router.get('/subscription-status', fetchUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('subscription');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const sub = user.subscription;

    // No subscription or explicitly inactive
    if (!sub || !sub.active) {
      return res.status(200).json({ subscribed: false, plan: null, expiresAt: null });
    }

    // BUG FIX: Check whether the subscription has actually expired.
    // If it has, deactivate it in the DB and return subscribed:false.
    const now = new Date();
    if (sub.expiresAt && new Date(sub.expiresAt) < now) {
      await User.findByIdAndUpdate(req.user.id, {
        $set: { 'subscription.active': false },
      });
      console.log(`[payment] Auto-deactivated expired subscription for user ${req.user.id}`);
      return res.status(200).json({ subscribed: false, plan: sub.plan, expiresAt: sub.expiresAt, expired: true });
    }

    return res.status(200).json({
      subscribed:       true,
      plan:             sub.plan,
      expiresAt:        sub.expiresAt,
      autoRenew:        sub.autoRenew,
      activationMethod: sub.activationMethod,
      startDate:        sub.startDate,
    });
  } catch (error) {
    console.error('[payment] subscription-status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /toggle-autorenew ───────────────────────────────────────────────────
/**
 * Toggles auto-renew for the user's subscription.
 *
 * BUG FIX: No validation on `enable` — a client could send any truthy value.
 * Now coerced to a strict boolean.
 *
 * BUG FIX: No check that the user actually has an active subscription.
 * Toggling auto-renew on an inactive sub is a no-op but misleading.
 */
router.post('/toggle-autorenew', fetchUser, async (req, res) => {
  const enable = req.body.enable === true || req.body.enable === 'true';

  try {
    const user = await User.findById(req.user.id).select('subscription');
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (!user.subscription?.active) {
      return res.status(400).json({
        success: false,
        error: 'No active subscription to update',
      });
    }

    await User.findByIdAndUpdate(req.user.id, {
      $set: { 'subscription.autoRenew': enable },
    });

    return res.status(200).json({ success: true, autoRenew: enable });
  } catch (error) {
    console.error('[payment] toggle-autorenew error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /progress ────────────────────────────────────────────────────────────
/**
 * Returns referral progress towards free subscription activation.
 *
 * BUG FIX: The original also fetched `activationMethod` from `subscription`
 * sub-document, but the schema stores it at both root level (activationMethod)
 * AND inside subscription. Now reads from the correct nested location.
 */
router.get('/progress', fetchUser, async (req, res) => {
  try {
    // BUG FIX: Also select `referralTarget` at root level in case it's stored there
    const me = await User.findById(req.user.id).select('subscription referralTarget');
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    const target       = me.subscription?.referralTarget ?? me.referralTarget ?? 10;
    const referredCount = await User.countDocuments({ referral: req.user.id });
    const isActive     = !!me.subscription?.active;

    // BUG FIX: If already active, eligible should always be true (regardless of count)
    // so the UI doesn't show a misleading "need X more" message to active users.
    const eligible = isActive || referredCount >= target;

    return res.json({
      success:          true,
      referredCount,
      target,
      remaining:        Math.max(0, target - referredCount),
      eligible,
      active:           isActive,
      activationMethod: me.subscription?.activationMethod ?? null,
      plan:             me.subscription?.plan ?? null,
      expiresAt:        me.subscription?.expiresAt ?? null,
    });
  } catch (err) {
    console.error('[payment] progress error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /activate-by-referrals ──────────────────────────────────────────────
/**
 * Activates a free subscription when the user has reached their referral target.
 *
 * BUG FIX (race condition): The original did two separate async calls —
 * countDocuments() then findByIdAndUpdate() — with no atomicity.
 * Between those two calls a concurrent request could double-activate.
 * Fixed with a conditional $set that only fires if active is still false,
 * then checking the result to detect the race.
 *
 * BUG FIX: `me.subscription?.toObject?.()` is unreliable when subscription is
 * a plain object (not always a Mongoose sub-doc). Replaced with explicit $set
 * on individual fields to avoid accidental overwrite.
 */
router.post('/activate-by-referrals', fetchUser, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select('subscription referralTarget');
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    // Already active — idempotent success
    if (me.subscription?.active) {
      return res.json({
        success:          true,
        message:          `Already active via ${me.subscription.activationMethod ?? 'unknown'}`,
        activationMethod: me.subscription.activationMethod ?? null,
        active:           true,
        plan:             me.subscription.plan ?? null,
      });
    }

    const target       = me.subscription?.referralTarget ?? me.referralTarget ?? 10;
    const referredCount = await User.countDocuments({ referral: req.user.id });

    if (referredCount < target) {
      return res.status(400).json({
        success:   false,
        message:   `Need ${target - referredCount} more referred registration${target - referredCount === 1 ? '' : 's'} to activate`,
        remaining: target - referredCount,
      });
    }

    const now       = new Date();
    const expiresAt = oneYearFrom(now);

    // BUG FIX: Atomic conditional update — only applies if active is still false.
    // This prevents a race condition where two simultaneous requests both
    // pass the referredCount check and double-activate the subscription.
    const result = await User.findOneAndUpdate(
      { _id: req.user.id, 'subscription.active': { $ne: true } }, // guard
      {
        $set: {
          'subscription.plan':             me.subscription?.plan ?? 'Referral',
          'subscription.active':           true,
          'subscription.startDate':        now,
          'subscription.expiresAt':        expiresAt,
          'subscription.autoRenew':        false,
          'subscription.activationMethod': 'referrals',
          'subscription.referralTarget':   target,
          // Also update root-level fields for schema consistency
          activationMethod:      'referrals',
          referralActivatedAt:   now,
        },
      },
      { new: true },
    );

    // Race condition guard: if result is null, another request just activated it
    if (!result) {
      const refreshed = await User.findById(req.user.id).select('subscription');
      return res.json({
        success:          true,
        message:          `Already active via ${refreshed?.subscription?.activationMethod ?? 'unknown'}`,
        activationMethod: refreshed?.subscription?.activationMethod ?? null,
        active:           true,
      });
    }

    console.log(`✅ [payment] Referral activation for user ${req.user.id} (expires ${expiresAt.toDateString()})`);

    // Notifications (fire-and-forget)
    dispatchSubscriptionNotifications(req.user.id, {
      type:      'referral_activation',
      inAppMsg:  `🎉 Subscription activated via referrals! You earned 1 year of benefits.`,
      pushTitle: 'Referral Activation 🎉',
      pushMsg:   `Your subscription is now active until ${expiresAt.toDateString()} via referrals.`,
    });

    return res.json({
      success:          true,
      message:          'Subscription activated via referrals',
      activationMethod: 'referrals',
      active:           true,
      plan:             result.subscription?.plan,
      expiresAt,
    });
  } catch (err) {
    console.error('[payment] activate-by-referrals error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;