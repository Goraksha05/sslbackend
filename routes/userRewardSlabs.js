// routes/userRewardSlabs.js
'use strict';

const express    = require('express');
const router     = express.Router();
const fetchUser  = require('../middleware/fetchuser');
const { readRewards, VALID_TYPES } = require('../utils/rewardManager');

/**
 * GET /api/rewards/:type
 * Returns the reward slabs for the logged-in user's current plan.
 * type = "referral" | "posts" | "streak"
 */
router.get('/:type', fetchUser, (req, res) => {
  const { type } = req.params;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({
      message: `Invalid reward type "${type}". Valid types: ${VALID_TYPES.join(', ')}`,
    });
  }

  // Support both planAmount (number) and plan name (string)
  let planKey = '2500';
  if (req.user.subscription?.planAmount) {
    planKey = String(req.user.subscription.planAmount);
  } else {
    const nameMap = { Basic: '2500', Silver: '3500', Gold: '4500' };
    planKey = nameMap[req.user.subscription?.plan] || '2500';
  }

  try {
    const slabs = readRewards(type, planKey);
    return res.json({ slabs, planKey, type });
  } catch (err) {
    console.error(`[GET /api/rewards/${type}]`, err.message);
    return res.status(400).json({ message: err.message });
  }
});

module.exports = router;