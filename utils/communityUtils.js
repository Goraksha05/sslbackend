// utils/communityUtils.js — Improved: iterative BFS (avoids stack overflow on large downlines)
const User = require('../models/User');

/**
 * Fetch all referred users in the downline using iterative BFS.
 * Avoids recursion stack overflow for large community trees.
 *
 * @param {ObjectId|String} userId - The root user whose community we're fetching
 * @returns {Promise<Set<string>>} - Set of user ID strings in the community (excluding root)
 */
async function getCommunityMembers(userId) {
  const visited = new Set();
  const queue   = [String(userId)];

  while (queue.length > 0) {
    // Process up to 50 nodes per batch for efficiency
    const batch = queue.splice(0, 50);

    // Avoid re-visiting already seen nodes
    const toFetch = batch.filter((id) => !visited.has(id));
    if (toFetch.length === 0) continue;

    toFetch.forEach((id) => visited.add(id));

    // Bulk query direct referrals for this batch
    const directRefs = await User.find({ referral: { $in: toFetch } })
      .select('_id')
      .lean();

    for (const ref of directRefs) {
      const refStr = ref._id.toString();
      if (!visited.has(refStr)) {
        queue.push(refStr);
      }
    }
  }

  // Exclude the root user from the result set
  visited.delete(String(userId));
  return visited;
}

/**
 * Count all members in the downline.
 * @param {ObjectId|String} userId
 * @returns {Promise<number>}
 */
async function getCommunityCount(userId) {
  const members = await getCommunityMembers(userId);
  return members.size;
}

/**
 * Get a paginated list of direct referrals (level-1 only).
 * Useful for UI lists where showing the full deep tree is unnecessary.
 *
 * @param {ObjectId|String} userId
 * @param {number} page  - 1-based page number
 * @param {number} limit - items per page
 * @returns {Promise<{ users: Array, total: number }>}
 */
async function getDirectReferrals(userId, page = 1, limit = 20) {
  const skip  = (page - 1) * limit;
  const query = { referral: userId };

  const [users, total] = await Promise.all([
    User.find(query)
      .select('name email username subscription.active date')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(query),
  ]);

  return { users, total };
}

module.exports = { getCommunityMembers, getCommunityCount, getDirectReferrals };