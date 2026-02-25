// jobs/streakReminderJob.js
const cron = require('node-cron');
const User = require('../models/User');
const Activity = require('../models/Activity');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/pushService');
const { getIO } = require('../sockets/IOsocket');
const notifyUser = require('../utils/notifyUser');

// Check every hour
cron.schedule('0 * * * *', async () => {
  try {
    console.log('⏰ Running per-user streak reminder check...');
    const now = new Date();

    const users = await User.find({}); // you may filter active users only

    for (const user of users) {
      const lastStreak = await Activity.findOne({
        user: user._id,
        dailystreak: { $exists: true }
      }).sort({ createdAt: -1 });

      // If no streak ever logged → treat as missed
      const lastTime = lastStreak ? new Date(lastStreak.createdAt) : null;
      const diffMs = lastTime ? now - lastTime : Infinity;
      const diffHrs = diffMs / (1000 * 60 * 60);

      if (diffHrs >= 24) {
        // Avoid spamming → check if we already sent reminder after last streak
        const lastReminder = await Notification.findOne({
          user: user._id,
          type: 'streak_reminder'
        }).sort({ createdAt: -1 });

        if (!lastReminder || (lastTime && new Date(lastReminder.createdAt) < lastTime)) {
          // ✅ Create Notification
          await Notification.create({
            user: user._id,
            sender: null,
            type: 'streak_reminder',
            message: `Don't forget to log your daily 🔥streak today! 🌟`,
            url: '/streaks'
          });

          // ✅ Toast notification
          await notifyUser(user._id, `Don't forget to log your daily 🔥streak today! 🌟`, 'streak_reminder');

          // ✅ Push
          sendPushToUser(user._id.toString(), {
            title: 'Daily Streak Reminder',
            message: `It’s been 24h since your last streak. Log today’s 🔥streak now! 🌟`,
            url: '/streaks'
          });

          // ✅ Socket
          const io = getIO();
          io.to(user._id.toString()).emit('notification', {
            type: 'streak_reminder',
            message: `Don’t forget to log your daily 🔥streak today! 🌟`
          });

          console.log(`📩 Streak reminder sent to ${user._id}`);
        }
      }
    }
  } catch (err) {
    console.error('Streak reminder job error:', err);
  }
});
