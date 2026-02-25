const cron = require('node-cron');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/pushService');
const { getIO } = require('../sockets/IOsocket');
const notifyUser = require('../utils/notifyUser');

// Run daily at 10 AM
cron.schedule('0 10 * * *', async () => {
  try {
    console.log('⏰ Checking subscription expiry reminders...');
    const now = new Date();

    // Fetch users with active subscription
    const users = await User.find({ 'subscription.active': true }).select('subscription name');

    for (const user of users) {
      if (!user.subscription?.expiresAt) continue;

      const expiresAt = new Date(user.subscription.expiresAt);
      const diffDays = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

      if (diffDays === 7 || diffDays === 1) {
        const reminderType = diffDays === 7 ? 'expiry_reminder_7d' : 'expiry_reminder_1d';
        const alreadySent = await Notification.findOne({
          user: user._id,
          type: reminderType
        });

        if (!alreadySent) {
          // ✅ DB notification
          await Notification.create({
            user: user._id,
            sender: null,
            type: reminderType,
            message: `⚠️ Your subscription will expire in ${diffDays} day${diffDays > 1 ? 's' : ''}. Renew to continue enjoying benefits.`,
            url: '/subscription'
          });

          // ✅ Toast notification
          await notifyUser(
            user._id,
            `⚠️ Your subscription expires in ${diffDays} day${diffDays > 1 ? 's' : ''}`,
            reminderType
          );

          // ✅ Push notification
          sendPushToUser(user._id.toString(), {
            title: 'Subscription Expiry Reminder',
            message: `Your plan will expire in ${diffDays} day${diffDays > 1 ? 's' : ''}. Renew now to stay active!`,
            url: '/subscription'
          });

          // ✅ Socket real-time notification
          const io = getIO();
          io.to(user._id.toString()).emit('notification', {
            type: reminderType,
            message: `⚠️ Subscription expiring in ${diffDays} day${diffDays > 1 ? 's' : ''}`
          });

          console.log(`📩 Expiry reminder sent to ${user._id} (${diffDays} days left)`);
        }
      }
    }
  } catch (err) {
    console.error('Subscription reminder job failed:', err);
  }
});
