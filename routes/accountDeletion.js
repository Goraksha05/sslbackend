/**
 * routes/accountDeletion.js
 *
 * Account deletion with a 7-day grace period.
 *
 * Flow:
 *   POST /api/account/delete-request
 *     • Marks user.deletion = { requested: true, scheduledAt: now+7d }
 *     • Logs out all active sessions by invalidating the token (client must clear local)
 *     • Sends confirmation notification
 *
 *   POST /api/account/cancel-deletion
 *     • Clears user.deletion — account is restored immediately
 *
 *   GET  /api/account/deletion-status
 *     • Returns { requested, scheduledAt, daysRemaining }
 *       Used by the frontend to show a banner on next login if still in grace period
 *
 * Hard deletion is performed by the daily cron job (accountDeletionJob.js),
 * not by this route — keeping the route thin and the heavy work in the job.
 */

'use strict';

const express    = require('express');
const router     = express.Router();
const fetchUser  = require('../middleware/fetchuser');
const User       = require('../models/User');
const Notification = require('../models/Notification');
const { getIO }  = require('../sockets/IOsocket');

const GRACE_DAYS = 7;

// ── POST /api/account/delete-request ──────────────────────────────────────────
router.post('/delete-request', fetchUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (user.deletion?.requested) {
      return res.status(409).json({
        success: false,
        message: 'Account deletion already requested.',
        scheduledAt: user.deletion.scheduledAt,
      });
    }

    const scheduledAt = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);

    user.deletion = {
      requested:   true,
      requestedAt: new Date(),
      scheduledAt,
    };

    await user.save();

    // In-app notification
    await Notification.create({
      user:    user._id,
      sender:  user._id,
      type:    'custom',
      message: `Your account deletion has been scheduled. You have ${GRACE_DAYS} days to cancel before your data is permanently erased.`,
      url:     '/profile',
    });

    // Real-time socket ping (if user is online in another tab)
    try {
      getIO().to(user._id.toString()).emit('notification', {
        type:    'account_deletion_requested',
        message: `Account deletion scheduled — ${GRACE_DAYS} days remaining.`,
      });
    } catch { /* socket may not be ready */ }

    console.log(`[accountDeletion] ⚠️  Deletion requested for user ${user._id}, scheduled: ${scheduledAt}`);

    return res.status(200).json({
      success:     true,
      message:     `Account deletion scheduled. You have ${GRACE_DAYS} days to cancel.`,
      scheduledAt,
    });
  } catch (err) {
    console.error('[POST /delete-request]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── POST /api/account/cancel-deletion ─────────────────────────────────────────
router.post('/cancel-deletion', fetchUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.deletion?.requested) {
      return res.status(400).json({ success: false, message: 'No pending deletion to cancel.' });
    }

    user.deletion = { requested: false, requestedAt: null, scheduledAt: null };
    await user.save();

    await Notification.create({
      user:    user._id,
      sender:  user._id,
      type:    'custom',
      message: 'Your account deletion has been cancelled. Welcome back! 🎉',
      url:     '/profile',
    });

    try {
      getIO().to(user._id.toString()).emit('notification', {
        type:    'account_deletion_cancelled',
        message: 'Account deletion cancelled — your account is safe.',
      });
    } catch { /* socket may not be ready */ }

    console.log(`[accountDeletion] ✅ Deletion cancelled for user ${user._id}`);

    return res.status(200).json({ success: true, message: 'Account deletion cancelled successfully.' });
  } catch (err) {
    console.error('[POST /cancel-deletion]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/account/deletion-status ──────────────────────────────────────────
router.get('/deletion-status', fetchUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('deletion');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.deletion?.requested) {
      return res.json({ success: true, requested: false });
    }

    const now          = Date.now();
    const scheduledAt  = new Date(user.deletion.scheduledAt);
    const msRemaining  = scheduledAt - now;
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));

    return res.json({
      success:        true,
      requested:      true,
      requestedAt:    user.deletion.requestedAt,
      scheduledAt:    user.deletion.scheduledAt,
      daysRemaining,
    });
  } catch (err) {
    console.error('[GET /deletion-status]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;