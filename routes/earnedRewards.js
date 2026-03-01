// routes/earnedRewards.js
// Mount on your Express app:
//   app.use('/api/auth', require('./routes/earnedRewards'));
// → exposes: GET /api/auth/earned-rewards

const express = require('express');
const router  = express.Router();
const fetchUser = require('../middleware/fetchuser');
const { getEarnedRewards } = require('../controllers/earnedRewardsController');

// GET /api/auth/earned-rewards
router.get('/earned-rewards', fetchUser, getEarnedRewards);

module.exports = router;