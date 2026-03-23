// jobs/streakReminderJob.js
//
// FIXES:
//   1. HIGH — `User.find({})` with no limit loaded the entire users collection
//      into memory every hour. With 10,000+ users this causes extreme memory
//      pressure and likely OOM. Replaced with paginated batch processing.
//
//   2. MEDIUM — Double notification creation: the job called Notification.create()
//      directly AND then called notifyUser() — which calls Notification.create()
//      internally. Every streak reminder created two DB records. Removed the
//      direct Notification.create() call; notifyUser() owns the DB write.
//
//   3. MEDIUM — getIO() was called outside a try/catch. If Socket.IO is not yet
//      initialised (e.g. during startup or a reconnect), this throws and kills
//      the entire cron execution for all remaining users. Wrapped in try/catch.

'use strict';

const cron     = require('node-cron');
const User     = require('../models/User');
const Activity = require('../models/Activity');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser         = require('../utils/notifyUser');

const BATCH_SIZE = 200;
const MSG        = "Don't forget to log your daily 🔥streak today! 🌟";

// Check every hour
cron.schedule('0 * * * *', async () => {
  console.log('⏰ Running per-user streak reminder check...');
  const now = new Date();
  let skip  = 0;
  let total = 0;

  try {
    while (true) {
      // FIX: paginate to avoid loading all users into memory at once
      const users = await User.find({})
        .select('_id lastActive')
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      if (users.length === 0) break;
      skip += BATCH_SIZE;

      for (const user of users) {
        try {
          const lastStreak = await Activity.findOne({
            user:        user._id,
            dailystreak: { $exists: true },
          }).sort({ createdAt: -1 }).lean();

          const lastTime = lastStreak ? new Date(lastStreak.createdAt) : null;
          const diffMs   = lastTime ? now - lastTime : Infinity;
          const diffHrs  = diffMs / (1000 * 60 * 60);

          if (diffHrs < 24) continue;

          // Avoid spamming: only send if we haven't sent a reminder since the last streak
          const lastReminder = await Notification.findOne({
            user: user._id,
            type: 'streak_reminder',
          }).sort({ createdAt: -1 }).lean();

          if (lastReminder && (!lastTime || new Date(lastReminder.createdAt) >= lastTime)) continue;

          // FIX: call notifyUser only — it handles the DB write internally.
          // Previously Notification.create() was called here AND notifyUser()
          // called it again, creating duplicate records.
          await notifyUser(user._id, MSG, 'streak_reminder', { url: '/streaks' });

          sendPushToUser(user._id.toString(), {
            title:   'Daily Streak Reminder',
            message: `It's been 24h since your last streak. Log today's 🔥streak now! 🌟`,
            url:     '/streaks',
          });

          // FIX: wrap socket access in try/catch so an uninitialised IO
          // instance doesn't abort processing of remaining users.
          try {
            const { getIO } = require('../sockets/IOsocket');
            getIO().to(user._id.toString()).emit('notification', { type: 'streak_reminder', message: MSG });
          } catch (socketErr) {
            // Socket not ready — push notification already handles delivery
          }

          total++;
          console.log(`📩 Streak reminder sent to ${user._id}`);
        } catch (userErr) {
          console.error(`[streakReminderJob] Error for user ${user._id}:`, userErr.message);
        }
      }
    }

    console.log(`[streakReminderJob] Done — ${total} reminders sent.`);
  } catch (err) {
    console.error('Streak reminder job error:', err);
  }
});