/**
 * utils/getPlanKey.js
 *
 * Single source of truth for resolving a user's subscription plan key.
 *
 * Plan key is always one of: '2500' | '3500' | '4500'
 *
 * Resolution priority:
 *   1. subscription.planAmount  (numeric value stored at payment time — most reliable)
 *   2. subscription.plan        (name-based — Basic/Standard/Silver/Premium/Gold)
 *   3. Default → '2500'         (Basic — safest fallback, never 4500)
 *
 * Why not just use subscription.plan?
 *   The payment route stores both plan name AND planAmount. Names are UI strings
 *   that have changed over time (Silver/Standard, Gold/Premium). planAmount is
 *   the canonical key because it directly maps to the reward JSON filename.
 */

'use strict';

// Map plan names → planAmount key
// Includes all aliases that have appeared in the codebase/payment route
const PLAN_NAME_MAP = {
  Basic:    '2500',
  Standard: '3500',
  Silver:   '3500',
  Gold:     '4500',
  Premium:  '4500',
  Referral: '2500',  // referral-activated users get Basic tier rewards
};

const VALID_PLAN_KEYS = new Set(['2500', '3500', '4500']);
const DEFAULT_PLAN    = '2500';

/**
 * Resolve the canonical plan key for a user.
 *
 * Accepts either:
 *   - A full Mongoose User document (or lean object) with a `subscription` field
 *   - A bare subscription sub-document { plan, planAmount }
 *
 * @param {object} userOrSub  User document OR subscription sub-document
 * @returns {'2500'|'3500'|'4500'}
 */
function getUserPlan(userOrSub) {
  // Handle both full user doc and bare subscription object
  const sub = userOrSub?.subscription ?? userOrSub;

  // Priority 1: numeric planAmount (set by payment.js at verify time)
  if (sub?.planAmount) {
    const key = String(sub.planAmount);
    if (VALID_PLAN_KEYS.has(key)) return key;
  }

  // Priority 2: plan name string
  if (sub?.plan && PLAN_NAME_MAP[sub.plan]) {
    return PLAN_NAME_MAP[sub.plan];
  }

  return DEFAULT_PLAN;
}

/**
 * Validate that a plan key string is one of the accepted values.
 * Throws a TypeError for invalid input — use in admin routes that accept
 * planKey as a URL param.
 *
 * @param {string} key
 * @returns {'2500'|'3500'|'4500'}
 */
function assertValidPlanKey(key) {
  const k = String(key);
  if (!VALID_PLAN_KEYS.has(k)) {
    throw new TypeError(`Invalid plan key: "${k}". Must be one of ${[...VALID_PLAN_KEYS].join(', ')}`);
  }
  return k;
}

module.exports = { getUserPlan, assertValidPlanKey, VALID_PLAN_KEYS, DEFAULT_PLAN, PLAN_NAME_MAP };