// jobs/nightly_rescorer.js
// Runs at 04:00 IST after vector builder (02:00) and graph job (03:00).
// Full MultiAccountScore + ReferralAbuseScore recomputation for every user.
// Writes updated scores to User.trustFlags and creates FraudEvents for
// any user whose score crosses a tier threshold.
//
// Schedule:
//   cron.schedule('30 22 * * *', runNightlyRescorer); // 22:30 UTC = 04:00 IST
'use strict';

const User                      = require('../models/User');
const { computeMultiAccountScore } = require('../services/multiAccountScorer');
const { computeReferralAbuseScore } = require('../services/referralAbuseScorer');
const { executeDefenseActions }    = require('../services/defenseActions');

const BATCH_SIZE = 100;

async function runNightlyRescorer() {
  console.log('[nightlyRescorer] Starting…');
  const t0 = Date.now();

  let skip       = 0;
  let processed  = 0;
  let flagged    = 0;
  let errors     = 0;

  while (true) {
    const users = await User.find({ role: 'user' })
      .select('_id trustFlags subscription')
      .skip(skip)
      .limit(BATCH_SIZE)
      .lean();

    if (users.length === 0) break;

    // Process batch concurrently (limited to batch size)
    await Promise.all(users.map(async (user) => {
      try {
        // Compute composite scores (no runtime context — batch mode)
        const [maResult, raResult] = await Promise.all([
          computeMultiAccountScore(user._id, {}),
          computeReferralAbuseScore(user._id),
        ]);

        const prevTier = user.trustFlags?.riskTier || 'clean';
        const newTier  = maResult.tier;

        // Only trigger defense actions if tier worsened
        const TIER_ORDER = { clean: 0, watchlist: 1, kyc_gate: 2, auto_flag: 3 };
        if (TIER_ORDER[newTier] > TIER_ORDER[prevTier]) {
          await executeDefenseActions(
            user._id,
            maResult,
            'nightly_batch',
            { batchRun: true },
            { referralAbuse: raResult.score }
          );
          flagged++;
        } else {
          // Still update the score without triggering actions
          await User.findByIdAndUpdate(user._id, {
            $set: {
              'trustFlags.riskScore':       maResult.score,
              'trustFlags.riskTier':        newTier,
              'trustFlags.referralAbuseScore': raResult.score,
              'trustFlags.lastEvaluatedAt': new Date(),
            },
          });
        }

        processed++;
      } catch (err) {
        console.error(`[nightlyRescorer] Error for ${user._id}:`, err.message);
        errors++;
      }
    }));

    skip += BATCH_SIZE;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[nightlyRescorer] Done. Processed: ${processed}, Newly flagged: ${flagged}, Errors: ${errors}, Time: ${elapsed}s`
  );
}

module.exports = { runNightlyRescorer };