// jobs/subscriptionReminderJob.js
//
// FIXES:
//   1. MEDIUM — Double notification creation: the job called Notification.create()
//      directly AND then called notifyUser() which creates another record internally.
//      Every expiry reminder created two DB notification rows. Removed the direct
//      Notification.create() call — notifyUser() owns the DB write.
//
//   2. MEDIUM — getIO() called outside try/catch; an uninitialised socket would
//      abort processing of all remaining users in the loop. Wrapped in try/catch.

'use strict';

const cron     = require('node-cron');
const User     = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser         = require('../utils/notifyUser');

// Run daily at 10 AM
cron.schedule('0 10 * * *', async () => {
  try {
    console.log('⏰ Checking subscription expiry reminders...');
    const now = new Date();

    const users = await User.find({ 'subscription.active': true })
      .select('subscription name')
      .lean();

    for (const user of users) {
      try {
        if (!user.subscription?.expiresAt) continue;

        const expiresAt = new Date(user.subscription.expiresAt);
        const diffDays  = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

        if (diffDays !== 7 && diffDays !== 1) continue;

        const reminderType = diffDays === 7 ? 'expiry_reminder_7d' : 'expiry_reminder_1d';
        const dayLabel     = `${diffDays} day${diffDays > 1 ? 's' : ''}`;

        // Idempotency: only send once per reminder type per subscription period.
        // Look for a reminder sent after the subscription start date.
        const alreadySent = await Notification.findOne({
          user: user._id,
          type: reminderType,
          ...(user.subscription.startDate
            ? { createdAt: { $gte: new Date(user.subscription.startDate) } }
            : {}),
        }).lean();

        if (alreadySent) continue;

        const message = `⚠️ Your subscription expires in ${dayLabel}`;

        // FIX: notifyUser handles the DB notification write — removed the
        // duplicate Notification.create() call that preceded it.
        await notifyUser(user._id, message, reminderType, { url: '/subscription' });

        sendPushToUser(user._id.toString(), {
          title:   'Subscription Expiry Reminder',
          message: `Your plan will expire in ${dayLabel}. Renew now to stay active!`,
          url:     '/subscription',
        });

        // FIX: socket wrapped in try/catch
        try {
          const { getIO } = require('../sockets/socketManager');
          getIO().to(user._id.toString()).emit('notification', {
            type:    reminderType,
            message: `⚠️ Subscription expiring in ${dayLabel}`,
          });
        } catch (socketErr) {
          // Socket not ready — push handles delivery
        }

        console.log(`📩 Expiry reminder sent to ${user._id} (${diffDays} days left)`);
      } catch (userErr) {
        console.error(`[subscriptionReminderJob] Error for user ${user._id}:`, userErr.message);
      }
    }
  } catch (err) {
    console.error('Subscription reminder job failed:', err);
  }
});