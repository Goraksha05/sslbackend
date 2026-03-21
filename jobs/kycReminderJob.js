/**
 * jobs/kycReminderJob.js
 *
 * FIXES vs original:
 *  1. Added missing `const cron = require('node-cron');` import
 *  2. Fixed notifyUser import — original used default import but
 *     notifyUser.js exports a named function, so destructure correctly
 *  3. Added graceful per-user error handling so one failure doesn't
 *     abort the entire batch
 *  4. Added platformEventBus KYC_REQUIRED event emission
 *
 * Install dependency if not already present:
 *   npm install node-cron
 */

'use strict';

const cron              = require('node-cron');
const User              = require('../models/User');
const { notifyUser }    = require('../utils/notifyUser');
const bus               = require('../intelligence/platformEventBus');

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
          'kyc_required',
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