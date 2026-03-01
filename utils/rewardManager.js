// utils/rewardManager.js
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_PLAN = '2500';
const VALID_TYPES  = ['referral', 'posts', 'streak'];
const VALID_PLANS  = ['2500', '3500', '4500'];

/**
 * Root directory where reward JSON files live.
 *
 * Resolution order (first match wins):
 *   1. REWARDS_DIR env var  — absolute path you set in .env  e.g. REWARDS_DIR=E:\sslapp\rewards
 *   2. Auto-detect          — walks up from __dirname until it finds a "rewards/" folder
 *      Works for any layout:
 *        backend/utils/rewardManager.js  → finds <project>/rewards/
 *        utils/rewardManager.js          → finds <project>/rewards/
 *        rewardManager.js                → finds <project>/rewards/
 *
 * If neither resolves, a clear startup error is thrown so you know immediately
 * rather than getting a cryptic "file unreadable" at request time.
 */
function resolveRewardsRoot() {
  // 1. Explicit env var (most reliable on Windows paths with spaces/drives)
  if (process.env.REWARDS_DIR) {
    const envPath = path.resolve(process.env.REWARDS_DIR);
    if (fs.existsSync(envPath)) return envPath;
    throw new Error(
      `[rewardManager] REWARDS_DIR env var is set to "${process.env.REWARDS_DIR}" ` +
      `but that directory does not exist. Create it or fix the path.`
    );
  }

  // 2. Walk up from __dirname looking for a sibling/ancestor "rewards/" folder
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {          // max 5 levels up — stops at filesystem root
    const candidate = path.join(dir, 'rewards');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;            // hit filesystem root
    dir = parent;
  }

  throw new Error(
    `[rewardManager] Could not find a "rewards/" directory.\n` +
    `  Searched from: ${__dirname}\n` +
    `  Fix: Add REWARDS_DIR=<absolute-path-to-rewards-folder> to your .env file.\n` +
    `  Example: REWARDS_DIR=E:\\sslapp\\rewards`
  );
}

// Resolve once at module load — fail fast at startup, not at request time
const REWARDS_ROOT = resolveRewardsRoot();

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function getRewardFilePath(type, plan) {
  return path.join(REWARDS_ROOT, type, `${plan}.json`);
}

/**
 * Resolve the best available plan key.
 * Falls back to DEFAULT_PLAN if the requested plan file doesn't exist.
 */
function resolvedPlanKey(type, plan) {
  const preferred = VALID_PLANS.includes(String(plan)) ? String(plan) : DEFAULT_PLAN;
  if (fs.existsSync(getRewardFilePath(type, preferred))) return preferred;

  // Only warn + fall back if it's a non-default plan — avoids infinite loop
  if (preferred !== DEFAULT_PLAN) {
    console.warn(
      `[rewardManager] "${type}/${preferred}.json" not found, falling back to ${DEFAULT_PLAN}`
    );
    if (fs.existsSync(getRewardFilePath(type, DEFAULT_PLAN))) return DEFAULT_PLAN;
  }

  throw new Error(
    `[rewardManager] Reward file missing for type="${type}" plan="${preferred}".\n` +
    `  Expected: ${getRewardFilePath(type, preferred)}\n` +
    `  Make sure the JSON files exist in: ${REWARDS_ROOT}`
  );
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Read and parse a reward slab JSON file.
 *
 * @param {'referral'|'posts'|'streak'} type
 * @param {string} plan  e.g. '2500' | '3500' | '4500'
 * @returns {Array}
 * @throws {Error} if the file is missing, unreadable, or malformed
 */
function readRewards(type, plan = DEFAULT_PLAN) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(
      `[rewardManager] Invalid reward type: "${type}". Valid: ${VALID_TYPES.join(', ')}`
    );
  }

  const planKey  = resolvedPlanKey(type, plan);
  const filePath = getRewardFilePath(type, planKey);

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`[rewardManager] Cannot read file: ${filePath}\n  ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[rewardManager] Invalid JSON in: ${filePath}\n  ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`[rewardManager] Expected a JSON array in: ${filePath}`);
  }

  return parsed;
}

/**
 * Write reward slabs (admin use).
 * Creates intermediate directories automatically.
 */
function writeRewards(type, plan = DEFAULT_PLAN, newData) {
  if (!VALID_TYPES.includes(type))  throw new Error(`Invalid reward type: "${type}"`);
  if (!Array.isArray(newData))      throw new Error('newData must be an array');

  const filePath = getRewardFilePath(type, plan);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf-8');
}

/**
 * Return slabs for a given type across all available plan tiers.
 * Skips tiers whose files don't exist (non-fatal).
 */
function readAllPlans(type) {
  return Object.fromEntries(
    VALID_PLANS
      .filter(p => fs.existsSync(getRewardFilePath(type, p)))
      .map(p  => [p, readRewards(type, p)])
  );
}

/** Expose the resolved root for debugging / admin routes */
function getRewardsRoot() {
  return REWARDS_ROOT;
}

module.exports = {
  readRewards,
  writeRewards,
  readAllPlans,
  getRewardsRoot,
  DEFAULT_PLAN,
  VALID_TYPES,
  VALID_PLANS,
};