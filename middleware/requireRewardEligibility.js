/**
 * middleware/requireRewardEligibility.js
 *
 * Enforces that the calling user meets BOTH eligibility conditions to claim any reward:
 *   1. KYC status === 'verified'
 *   2. subscription.active === true AND subscription has not expired
 *
 * Must be placed AFTER fetchUser in the middleware chain.
 *
 * Returns structured 403 responses so the frontend can render contextual
 * CTAs (e.g. navigate to KYC form or subscription page) based on the
 * `code` field without pattern-matching on message strings.
 *
 * Response shape on failure:
 *   {
 *     message:  string,           // human-readable
 *     code:     string,           // machine-readable gate identifier
 *     gates: {                    // individual gate states
 *       kyc:          { passed: boolean, status: string },
 *       subscription: { passed: boolean, active: boolean, plan: string|null }
 *     }
 *   }
 *
 * Possible codes:
 *   REWARDS_FROZEN          — trustFlags.rewardsFrozen is true
 *   KYC_NOT_VERIFIED        — KYC not verified (includes not_started / submitted / rejected)
 *   SUBSCRIPTION_REQUIRED   — no active subscription
 *   KYC_AND_SUBSCRIPTION    — both gates failed (shown on first-time users)
 */

'use strict';

const User = require('../models/User');

/**
 * Check whether a subscription is currently active and not expired.
 */
function isSubscriptionActive(sub) {
  if (!sub?.active) return false;
  if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) return false;
  return true;
}

/**
 * Express middleware.
 * Reads the full user document so we get the latest trust flags, KYC, and
 * subscription state — not the JWT-cached snapshot from fetchUser.
 */
const requireRewardEligibility = async (req, res, next) => {
  try {
    // fetchUser already verified the token and set req.user.id
    const user = await User.findById(req.user.id)
      .select('kyc subscription trustFlags')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    // ── Trust / fraud gate (highest priority) ─────────────────────────────
    if (user.trustFlags?.rewardsFrozen) {
      return res.status(403).json({
        message: 'Your reward payouts are temporarily suspended pending verification. Please contact support.',
        code:    'REWARDS_FROZEN',
        gates: {
          kyc:          { passed: user.kyc?.status === 'verified', status: user.kyc?.status ?? 'not_started' },
          subscription: { passed: isSubscriptionActive(user.subscription), active: !!user.subscription?.active, plan: user.subscription?.plan ?? null },
        },
      });
    }

    // ── Individual gate evaluation ─────────────────────────────────────────
    const kycPassed  = user.kyc?.status === 'verified';
    const subPassed  = isSubscriptionActive(user.subscription);

    if (!kycPassed && !subPassed) {
      return res.status(403).json({
        message: 'You need to complete KYC verification and activate a subscription to claim rewards.',
        code:    'KYC_AND_SUBSCRIPTION',
        gates: {
          kyc:          { passed: false, status: user.kyc?.status ?? 'not_started' },
          subscription: { passed: false, active: false, plan: null },
        },
      });
    }

    if (!kycPassed) {
      const kycStatus = user.kyc?.status ?? 'not_started';
      const kycMessages = {
        not_started: 'Please complete your KYC verification to claim rewards.',
        required:    'KYC verification is required before you can claim rewards.',
        submitted:   'Your KYC is under review. Rewards will be unlocked once verified.',
        rejected:    'Your KYC was not approved. Please resubmit your documents to claim rewards.',
      };
      return res.status(403).json({
        message: kycMessages[kycStatus] ?? 'KYC verification is required to claim rewards.',
        code:    'KYC_NOT_VERIFIED',
        gates: {
          kyc:          { passed: false, status: kycStatus },
          subscription: { passed: subPassed, active: !!user.subscription?.active, plan: user.subscription?.plan ?? null },
        },
      });
    }

    if (!subPassed) {
      const expired = user.subscription?.active && user.subscription?.expiresAt
        && new Date(user.subscription.expiresAt) < new Date();
      return res.status(403).json({
        message: expired
          ? 'Your subscription has expired. Please renew to claim rewards.'
          : 'An active subscription is required to claim rewards.',
        code:    'SUBSCRIPTION_REQUIRED',
        gates: {
          kyc:          { passed: true, status: 'verified' },
          subscription: { passed: false, active: !!user.subscription?.active, expired: !!expired, plan: user.subscription?.plan ?? null },
        },
      });
    }

    // All gates passed — attach enriched flags for downstream handlers
    req.rewardEligibility = {
      kycStatus: 'verified',
      plan:      user.subscription?.plan ?? null,
      expiresAt: user.subscription?.expiresAt ?? null,
    };

    next();
  } catch (err) {
    console.error('[requireRewardEligibility]', err);
    return res.status(500).json({ message: 'Eligibility check failed. Please try again.' });
  }
};

module.exports = requireRewardEligibility;