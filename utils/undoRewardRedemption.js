// utils/undoRewardRedemption.js

async function undoRedemption(user, type, slab) {
  let updated = false;

  switch (type) {
    case 'referral':
      if (user.redeemedReferralSlabs?.includes(slab)) {
        user.redeemedReferralSlabs = user.redeemedReferralSlabs.filter(s => s !== slab);
        // const reward = require('./calculateReferralReward').calculateReferralReward(slab);
        const plan   = (user.subscription?.planAmount || '2500').toString();
        const reward = require('./tierCalculation/calculateReferralReward').calculateReferralReward(slab, plan);
        user.totalGroceryCoupons -= reward.groceryCoupons || 0;
        user.totalShares -= reward.shares || 0;
        user.totalReferralToken -= reward.referralToken || 0;
        updated = true;
      }
      break;

    case 'post':
      if (user.redeemedPostSlabs?.includes(slab)) {
        user.redeemedPostSlabs = user.redeemedPostSlabs.filter(s => s !== slab);
        // const reward = require('./calculatePostsReward').calculatePostsReward(slab);
        const plan   = (user.subscription?.planAmount || '2500').toString();
        const reward = require('./tierCalculation/calculatePostsReward').calculatePostsReward(slab, plan);
        user.totalGroceryCoupons -= reward.groceryCoupons || 0;
        user.totalShares -= reward.shares || 0;
        updated = true;
      }
      break;

    case 'streak':
      if (user.redeemedStreakSlabs?.includes(slab)) {
        user.redeemedStreakSlabs = user.redeemedStreakSlabs.filter(s => s !== slab);
        // const reward = require('./calculateStreakReward').calculateStreakReward(slab);
        const plan   = (user.subscription?.planAmount || '2500').toString();
        const reward = require('./tierCalculation/calculateStreakReward').calculateStreakReward(slab, plan);
        user.totalGroceryCoupons -= reward.groceryCoupons || 0;
        updated = true;
      }
      break;

    default:
      throw new Error(`Unknown reward type: ${type}`);
  }

  if (updated) {
    await user.save();
  }

  return updated;
}

module.exports = { undoRedemption };
