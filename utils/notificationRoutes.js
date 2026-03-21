// backend/utils/notificationRoutes.js
//
// Maps notification types → frontend deep-link routes.
// Used by the notification bell to know where to navigate on click.

const notificationRoutes = {
  // 🔥 Streaks
  streak_reminder: "/streaks",
  daily_streak: "/streaks",
  streak_reward: "/streaks",

  // 💳 Payments & Subscription
  expiry_reminder_7d: "/rewards",
  expiry_reminder_1d: "/rewards",
  payment_success: "/rewards",
  auto_renew: "/rewards",

  // 👥 Social / Friends
  friend_request: "/notifications",
  friend_accept: "/notifications",
  friend_decline: "/notifications",
  comment: "/notifications",
  like: "/notifications",

  // 👤 Referrals
  referral_signup: "/referrals",
  referral_reward: "/referrals",
  referral_activation: "/referrals",

  // 📝 Posts
  post_reward: "/posts",
  post_deleted: "/posts",   // was missing — now included

  // 🛠️ Fallback
  custom: "/",

  // eKYC
  kyc_required: "/kyc",
  kyc_verified: "/profile",
  kyc_rejected: "/kyc"

};

/**
 * @param {string} type      Notification type from the schema enum
 * @param {string} [fallback="/"]  Returned when type is unknown
 * @returns {string}
 */
function getNotificationRoute(type, fallback = "/") {
  return notificationRoutes[type] ?? fallback;
}

module.exports = { getNotificationRoute, notificationRoutes };