const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

// 👇 Make sure this points to your frontend domain (where /logo.png is served)
const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || 'https://api.sosholife.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn(
    "[pushService] Missing VAPID keys. Push notifications will be disabled."
  );
};

async function sendPushToUser(userId, payload) {
  const subs = await PushSubscription.find({ user: userId });
  if (!subs.length) return;

  // Normalize payload: always object
  let data = {};
  if (typeof payload === 'string') {
    data = { title: 'SoShoLife', message: payload };
  } else {
    data = { ...payload };
  }

    // Always enforce logo and defaults
  data.title = data.title || 'SoShoLife';
  data.icon = data.icon || `${FRONTEND_BASE}/logo.png`;
  data.badge = data.badge || `${FRONTEND_BASE}/logo.png`;
  data.image = data.image || `${FRONTEND_BASE}/logo.png`;
  data.url = data.url || '/';

  const serialized = JSON.stringify(data);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        serialized,
        { TTL: 3600 } // 1h TTL
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await PushSubscription.deleteOne({ _id: sub._id });
        console.log('[pushService] Removed stale subscription:', sub.endpoint);
      } else {
        console.error('[pushService] WebPush error:', err.statusCode, err.body || err.message);
      }
    }
  }
}

module.exports = { sendPushToUser };