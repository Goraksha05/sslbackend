/**
 * jobs/kycReminderJob.js
 *
 * FIX: `const { notifyUser } = require('../utils/notifyUser')` destructures
 * a default export, yielding `undefined`. notifyUser.js does:
 *   module.exports = notifyUser;          ← default export
 *   module.exports.notifyMany = notifyMany;
 * The correct import for the default is: `const notifyUser = require(...)`.
 * Previously every call to notifyUser() threw "notifyUser is not a function"
 * (swallowed by the per-user catch block), so zero KYC reminders were ever sent.
 */

'use strict';

const cron       = require('node-cron');
const User       = require('../models/User');
// FIX: default import — not destructured
const notifyUser = require('../utils/notifyUser');
const bus        = require('../intelligence/platformEventBus');

/**
 * Runs at 10:00 AM every day.
 * Sends a KYC reminder to any user whose KYC status is 'required'
 * AND who was active today.
 */
cron.schedule('0 10 * * *', async () => {
  console.log('[kycReminderJob] Running daily KYC reminder job…');

  let reminded = 0;
  let errors   = 0;

  try {
    const users = await User.find({ 'kyc.status': 'required' })
      .select('_id kyc lastActive')
      .lean();

    const today = new Date().toDateString();

    for (const user of users) {
      try {
        const activeToday =
          user.lastActive &&
          new Date(user.lastActive).toDateString() === today;

        if (!activeToday) continue;

        await notifyUser(
          user._id,
          '⚠️ Complete your KYC to unlock features',
          'custom',        // 'kyc_required' is not in the Notification schema enum
          { url: '/kyc' }
        );

        bus.emit(bus.EVENTS.KYC_REQUIRED, {
          userId: String(user._id),
          source: 'reminder_job',
        });

        reminded++;
      } catch (userErr) {
        console.error(
          `[kycReminderJob] Failed to notify user ${user._id}:`,
          userErr.message
        );
        errors++;
      }
    }

    console.log(
      `[kycReminderJob] Done — ${reminded} reminders sent, ${errors} errors.`
    );

  } catch (err) {
    console.error('[kycReminderJob] Fatal error:', err.message);
  }
});