const express = require('express');
const router = express.Router();
const fetchUser = require('../middleware/fetchuser');
const PushSubscription = require('../models/PushSubscription');

router.get('/vapid-public-key', (req, res) => {
  res.status(200).json({ key: process.env.VAPID_PUBLIC || '' });
});

// Save/replace a subscription for the current user
router.post('/subscribe', fetchUser, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ status: 'error', message: 'Invalid subscription' });
    }

    // Upsert by endpoint for idempotency
    await PushSubscription.updateOne(
      { endpoint },
      { user: req.user.id, endpoint, keys, userAgent: req.get('User-Agent') || '' },
      { upsert: true }
    );

    res.status(201).json({ status: 'success' });
  } catch (e) {
    console.error('[push] subscribe error:', e.message);
    res.status(500).json({ status: 'error' });
  }
});

// Remove a subscription (e.g., on logout)
router.post('/unsubscribe', fetchUser, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ status: 'error', message: 'Missing endpoint' });

    await PushSubscription.deleteOne({ endpoint, user: req.user.id });
    res.status(200).json({ status: 'success' });
  } catch (e) {
    console.error('[push] unsubscribe error:', e.message);
    res.status(500).json({ status: 'error' });
  }
});

module.exports = router;
