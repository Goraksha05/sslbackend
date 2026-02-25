// utils/rewardManager.js
const fs   = require('fs');
const path = require('path');

/** Fallback if the user is unsubscribed or on an unrecognised tier */
const DEFAULT_PLAN = '2500';

/** rewards/<type>/<plan>.json */
function getRewardFile(type, plan = DEFAULT_PLAN) {
  return path.join(__dirname, `../rewards/${type}/${plan}.json`);
}

function readRewards(type, plan = DEFAULT_PLAN) {
  const filePath = getRewardFile(type, plan);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Reward slab file not found for ${type} – ₹${plan} plan`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeRewards(type, plan = DEFAULT_PLAN, newData) {
  const filePath = getRewardFile(type, plan);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf-8');
}

module.exports = { readRewards, writeRewards, DEFAULT_PLAN };
