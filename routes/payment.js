const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const router = express.Router();
const User = require('../models/User');
const fetchUser = require('../middleware/fetchuser');
const Notification = require('../models/Notification');
const { getIO } = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser = require('../utils/notifyUser');

require('dotenv').config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ======================
// ORDER CREATION
// ======================
router.post('/create-order', fetchUser, async (req, res) => {
  const { amount, planName } = req.body;

  try {
    const order = await razorpay.orders.create({
      amount: amount, // in paise
      currency: 'INR',
      receipt: `receipt_order_${Date.now()}`,
      notes: {
        userId: req.user.id,
        planName
      }
    });

    res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    res.status(500).json({ success: false, error: 'Order creation failed' });
  }
});

// ======================
// VERIFY PAYMENT
// ======================
router.post('/verify', fetchUser, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName } = req.body;

  try {
    // Step 1: Verify Signature
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    // Step 2: Save subscription to user document
    const now = new Date();
    const oneYearLater = new Date(now);
    oneYearLater.setFullYear(now.getFullYear() + 1);

    await User.findByIdAndUpdate(req.user.id, {
      subscription: {
        plan: planName,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        active: true,
        startDate: now,
        autoRenew: false,
        activationMethod: 'paid',
        expiresAt: oneYearLater,
        referralTarget: (User?.subscription?.referralTarget ?? 10)
      }
    });

    console.log(`✅ Verified & Subscribed user ${req.user.id} to ${planName}`);

    // ✅ Notify user
    await Notification.create({
      user: req.user.id,
      sender: null,
      type: 'payment_success',
      message: `Payment successful! Your ${planName} plan is now active 🎉`,
      url: '/subscription'
    });

    await notifyUser(req.user.id, `Payment successful! Your ${planName} plan is now active 🎉`, 'payment_success');

    sendPushToUser(req.user.id.toString(), {
      title: 'Subscription Activated',
      message: `Your ${planName} plan is active until ${oneYearLater.toDateString()}`,
      url: '/subscription'
    });

    const io = getIO();
    io.to(req.user.id.toString()).emit('notification', {
      type: 'payment_success',
      message: `Your ${planName} subscription is now active 🎉`
    });

    res.status(200).json({ success: true, message: 'Payment verified and subscription saved' });
  } catch (error) {
    console.error('Payment verification failed:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ======================
// GET USER SUBSCRIPTION STATUS
// ======================
router.get('/subscription-status', fetchUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('subscription');

    if (!user || !user.subscription || !user.subscription.active) {
      return res.status(200).json({
        subscribed: false,
        plan: null,
        expiresAt: null
      });
    }

    const { plan, expiresAt, autoRenew } = user.subscription;
    res.status(200).json({
      subscribed: true,
      plan,
      expiresAt,
      autoRenew
    });

  } catch (error) {
    console.error('Error fetching subscription status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle auto-renew
router.post('/toggle-autorenew', fetchUser, async (req, res) => {
  const { enable } = req.body;

  try {
    await User.findByIdAndUpdate(req.user.id, {
      'subscription.autoRenew': enable
    });

    res.status(200).json({ success: true, autoRenew: enable });
  } catch (error) {
    console.error('Error updating auto-renew:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ======================
// REFERRAL PROGRESS
// ======================
router.get('/progress', fetchUser, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select('subscription');
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    const target = me.subscription?.referralTarget ?? 10;
    const referredCount = await User.countDocuments({ referral: req.user.id });
    const eligible = referredCount >= target;

    res.json({
      success: true,
      referredCount,
      target,
      remaining: Math.max(0, target - referredCount),
      eligible,
      active: !!me.subscription?.active,
      activationMethod: me.subscription?.activationMethod || null,
      plan: me.subscription?.plan || null,
    });
  } catch (err) {
    console.error('progress error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ======================
// ACTIVATE BY REFERRALS
// ======================
router.post('/activate-by-referrals', fetchUser, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    const target = me.subscription?.referralTarget ?? 10;
    const referredCount = await User.countDocuments({ referral: req.user.id });
    const alreadyActive = !!me.subscription?.active;

    if (alreadyActive) {
      return res.json({
        success: true,
        message: `Already active via ${me.subscription?.activationMethod || 'unknown'}`,
        activationMethod: me.subscription?.activationMethod || null,
        active: true
      });
    }

    if (referredCount < target) {
      return res.status(400).json({
        success: false,
        message: `Need ${target - referredCount} more referred registrations to activate`
      });
    }

    const now = new Date();
    const oneYearLater = new Date(now);
    oneYearLater.setFullYear(now.getFullYear() + 1);

    await User.findByIdAndUpdate(req.user.id, {
      $set: {
        subscription: {
          ...me.subscription?.toObject?.() || me.subscription || {},
          plan: me.subscription?.plan || 'Referral',
          active: true,
          startDate: now,
          expiresAt: oneYearLater,
          autoRenew: false,
          activationMethod: 'referrals',
          referralActivatedAt: now,
          referralTarget: target
        }
      }
    });

    // ✅ Notify user
    await Notification.create({
      user: req.user.id,
      sender: null,
      type: 'referral_activation',
      message: `🎉 Subscription activated via referrals! You earned 1 year of benefits.`,
      url: '/subscription'
    });

    await notifyUser(req.user.id, `🎉 Subscription activated via referrals!`, 'referral_activation');

    sendPushToUser(req.user.id.toString(), {
      title: 'Referral Activation',
      message: `Your subscription is now active until ${oneYearLater.toDateString()} via referrals.`,
      url: '/subscription'
    });

    const io = getIO();
    io.to(req.user.id.toString()).emit('notification', {
      type: 'referral_activation',
      message: `Your subscription was activated via referrals 🎉`
    });

    return res.json({
      success: true,
      message: 'Subscription activated via referrals',
      activationMethod: 'referrals',
      active: true
    });

  } catch (err) {
    console.error('activate-by-referrals error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


module.exports = router;
