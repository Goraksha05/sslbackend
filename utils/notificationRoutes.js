// backend/utils/notificationRoutes.js

const notificationRoutes = {
  // Streak-related
  streak_reminder: "/streaks",
  daily_streak: "/streaks",
  streak_reward: "/streaks",

  // Subscription & payments
  expiry_reminder_7d: "/rewards",
  expiry_reminder_1d: "/rewards",
  payment_success: "/rewards",
  auto_renew: "/rewards",

  // Social / friends
  friend_request: "/notifications",
  friend_accept: "/notifications",
  friend_decline: "/notifications",
  comment: "/notifications",
  like: "/notifications",

  // Referrals
  referral_signup: "/referrals",
  referral_reward: "/referrals",
  referral_activation: "/referrals",

  // Posts
  post_reward: "/posts",

  // Default fallback
  custom: "/",
};

function getNotificationRoute(type, fallback = "/") {
  return notificationRoutes[type] || fallback;
}

module.exports = { getNotificationRoute };
