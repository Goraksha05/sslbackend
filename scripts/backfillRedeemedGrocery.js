// scripts/backfillRedeemedGrocery.js
// Run once: node scripts/backfillRedeemedGrocery.js
// Safe to run multiple times (idempotent via $set, not $inc)

require('dotenv').config();
const mongoose = require('mongoose');
const Payout   = require('../models/PayoutSchema');
const User     = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Computing redeemed amounts...');

  // Aggregate total redeemed per user from Payout documents
  // Count ALL payout statuses except 'failed' (failed = not actually paid out)
  const redemptions = await Payout.aggregate([
    {
      $match: {
        rewardType: 'grocery_redeem',
        status: { $in: ['pending', 'processing', 'paid', 'on_hold'] },
      },
    },
    {
      $group: {
        _id:   '$user',
        total: { $sum: '$cashAmountINR' },
      },
    },
  ]);

  console.log(`Found ${redemptions.length} users with prior redemptions.`);

  let updated = 0;
  for (const r of redemptions) {
    await User.findByIdAndUpdate(r._id, {
      $set: { totalRedeemedGrocery: r.total },
    });
    updated++;
    if (updated % 100 === 0) console.log(`  Updated ${updated}...`);
  }

  console.log(`Done. ${updated} users backfilled.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });