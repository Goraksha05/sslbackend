const rewardSlabs = require('../config/streakRewards.json');

function calculateStreakReward(dailystreak) {
  const matched = rewardSlabs.find(item => item.streakslab === dailystreak);
  return matched || { groceryCoupons: 0, shares: 0, referralToken: 0 };
}

function getStreakSlabProgress(streakCount) {
  const sorted = [...rewardSlabs].sort((a, b) => a.streakslab - b.streakslab);
  let reached = null, next = null;
  for (let i = 0; i < sorted.length; i++) {
    if (streakCount >= sorted[i].streakslab) {
      reached = sorted[i];
    } else {
      next = sorted[i];
      break;
    }
  }
  return { reached, next };
}

module.exports = {
  calculateStreakReward,
  getStreakSlabProgress
};
