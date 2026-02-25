const express = require('express');
const router = express.Router();
const { readRewards, writeRewards } = require('../utils/rewardManager');

// Middleware to restrict access (stubbed here — implement auth in real app)
function isAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ message: 'Admin access required' });
}

// ---------------------------
// GET: View Reward Slabs
// ---------------------------
router.get('/rewards/:type/:plan', isAdmin, (req, res) => {
  try {
    const { type, plan } = req.params;
    const rewards = readRewards(type, plan);
    res.json({ rewards });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PUT /api/admin/rewards/:type/:plan */
router.put('/rewards/:type/:plan', isAdmin, (req, res) => {
  try {
    const { type, plan } = req.params;
    const newSlabs = req.body;
    if (!Array.isArray(newSlabs)) {
      return res.status(400).json({ message: 'Expected an array of slabs' });
    }
    writeRewards(type, plan, newSlabs);
    res.json({ message: 'Rewards updated for plan ₹' + plan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
