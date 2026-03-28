/**
 * utils/undoRewardRedemption.js  (Refactored)
 *
 * Now delegates all undo logic to RewardEngine.undoReward().
 * Kept as a thin wrapper so existing callers (adminRoutes.js) work unchanged.
 */

'use strict';

const { undoReward } = require('../services/RewardEngine');

/**
 * @param {object} user     Mongoose User document (we only need _id)
 * @param {'referral'|'post'|'streak'} type
 * @param {number|string} slab
 * @returns {Promise<boolean>}
 */
async function undoRedemption(user, type, slab) {
  return undoReward(user._id, type, slab);
}

module.exports = { undoRedemption };