// routes/userRewardSlabs.js
const express = require('express');
const router  = express.Router();
const fetchUser  = require('../middleware/fetchuser');          // ← your JWT auth middleware
const { readRewards } = require('../utils/rewardManager');

// GET /api/rewards/:type   (type = "referral" | "posts" | "streak")
router.get('/:type', fetchUser, (req, res) => {
  const { type } = req.params;
  const plan = String(req.user.subscription?.planAmount || '2500');
  try {
    const slabs = readRewards(type, plan);
    res.json({ slabs });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
