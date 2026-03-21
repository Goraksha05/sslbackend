// applyRewardUtils.js

async function applyRewardsToUser(user, rewards) {
  // 🔐 KYC ENFORCEMENT (CRITICAL)
  if (user.kyc?.status !== 'verified') {
    throw new Error('KYC required to claim rewards');
  }

  if (!user.rewards) user.rewards = {};

  user.rewards.groceryCoupons =
    (user.rewards.groceryCoupons || 0) + (rewards.groceryCoupons || 0);
  user.rewards.shares =
    (user.rewards.shares || 0) + (rewards.shares || 0);
  user.rewards.referralTokens =
    (user.rewards.referralTokens || 0) + (rewards.referralToken || 0);

  return user.save(); // or return await userRepo.updateUser(user) depending on your DB pattern
}

module.exports = {
  applyRewardsToUser
};
