// services/simulationEngine.js
'use strict';

const { readRewards } = require('../utils/rewardManager');

// ── Agent strategies ──────────────────────────────────────────────────────────
const STRATEGIES = {
  ORGANIC: 'organic',
  STREAK_FARMER: 'streak_farmer',
  POST_FARMER: 'post_farmer',
  REFERRAL_RING: 'referral_ring',
  COMBINED_ABUSER: 'combined',
};

// ── Strategy parameters (WITH KYC MODELING) ───────────────────────────────────
const STRATEGY_PARAMS = {
  [STRATEGIES.ORGANIC]: {
    postsPerMonth: 8,
    referralsPerMonth: 1,
    streakDaysPerMonth: 15,
    accountsPerOperator: 1,
    detectionRisk: 0.05,
    kycSuccessRate: 0.9,
  },
  [STRATEGIES.STREAK_FARMER]: {
    postsPerMonth: 2,
    referralsPerMonth: 0,
    streakDaysPerMonth: 30,
    accountsPerOperator: 1,
    detectionRisk: 0.15,
    kycSuccessRate: 0.7,
  },
  [STRATEGIES.POST_FARMER]: {
    postsPerMonth: 50,
    referralsPerMonth: 0,
    streakDaysPerMonth: 20,
    accountsPerOperator: 1,
    detectionRisk: 0.4,
    kycSuccessRate: 0.6,
  },
  [STRATEGIES.REFERRAL_RING]: {
    postsPerMonth: 5,
    referralsPerMonth: 8,
    streakDaysPerMonth: 10,
    accountsPerOperator: 6,
    detectionRisk: 0.6,
    kycSuccessRate: 0.2, // 🔥 MOST FAIL KYC
  },
  [STRATEGIES.COMBINED_ABUSER]: {
    postsPerMonth: 30,
    referralsPerMonth: 5,
    streakDaysPerMonth: 28,
    accountsPerOperator: 4,
    detectionRisk: 0.75,
    kycSuccessRate: 0.3,
  },
};

// ── Earnings calculator (WITH KYC ENFORCEMENT) ────────────────────────────────
function calculateAgentEarnings(params, slabs, months) {
  const {
    postsPerMonth,
    referralsPerMonth,
    streakDaysPerMonth,
    accountsPerOperator,
    kycSuccessRate,
  } = params;

  let totalGrocery = 0;
  let totalShares = 0;
  let totalToken = 0;
  let blockedReferralRewards = 0;

  let cumulativePosts = 0;
  let cumulativeRefs = 0;
  let cumulativeStreak = 0;

  const claimedPostMilestones = new Set();
  const claimedReferralMilestones = new Set();
  const claimedStreakMilestones = new Set();

  for (let month = 1; month <= months; month++) {
    cumulativePosts += postsPerMonth;
    cumulativeRefs += referralsPerMonth;
    cumulativeStreak += streakDaysPerMonth;

    // ── POSTS ──
    for (const slab of slabs.posts || []) {
      if (!claimedPostMilestones.has(slab.postsCount) && cumulativePosts >= slab.postsCount) {
        totalGrocery += slab.groceryCoupons || 0;
        totalShares += slab.shares || 0;
        claimedPostMilestones.add(slab.postsCount);
      }
    }

    // ── REFERRALS (🔐 KYC ENFORCED) ──
    for (const slab of slabs.referral || []) {
      if (!claimedReferralMilestones.has(slab.referralCount) && cumulativeRefs >= slab.referralCount) {

        const verifiedAccounts = Math.round(accountsPerOperator * (kycSuccessRate || 0));
        const blockedAccounts = accountsPerOperator - verifiedAccounts;

        // ✅ Only verified accounts earn
        if (verifiedAccounts > 0) {
          totalGrocery += (slab.groceryCoupons || 0) * verifiedAccounts;
          totalShares += (slab.shares || 0) * verifiedAccounts;
          totalToken += (slab.referralToken || 0) * verifiedAccounts;
        }

        // 🚫 Blocked rewards (KYC failed)
        if (blockedAccounts > 0) {
          blockedReferralRewards += blockedAccounts * (
            (slab.groceryCoupons || 0) * 50 +
            (slab.shares || 0) * 100 +
            (slab.referralToken || 0) * 30
          );
        }

        claimedReferralMilestones.add(slab.referralCount);
      }
    }

    // ── STREAK ──
    for (const slab of slabs.streak || []) {
      if (!claimedStreakMilestones.has(slab.dailystreak) && cumulativeStreak >= slab.dailystreak) {
        totalGrocery += slab.groceryCoupons || 0;
        claimedStreakMilestones.add(slab.dailystreak);
      }
    }
  }

  return {
    totalGrocery,
    totalShares,
    totalToken,
    blockedReferralRewards,
  };
}

// ── Simulation ────────────────────────────────────────────────────────────────
async function runSimulation({
  plan = '2500',
  totalUsers = 10000,
  months = 6,
  runs = 1000,
  overrides = {},
}) {
  let slabs = {};
  try {
    slabs.posts = overrides.posts || readRewards('posts', plan);
    slabs.referral = overrides.referral || readRewards('referral', plan);
    slabs.streak = overrides.streak || readRewards('streak', plan);
  } catch (err) {
    throw new Error(`[simulationEngine] Failed to load slabs: ${err.message}`);
  }

  const strategyMix = {
    [STRATEGIES.ORGANIC]: 0.7,
    [STRATEGIES.STREAK_FARMER]: 0.12,
    [STRATEGIES.POST_FARMER]: 0.08,
    [STRATEGIES.REFERRAL_RING]: 0.06,
    [STRATEGIES.COMBINED_ABUSER]: 0.04,
  };

  const results = {};

  for (const [strategy, fraction] of Object.entries(strategyMix)) {
    const params = STRATEGY_PARAMS[strategy];
    const strategyUsers = Math.round(totalUsers * fraction);

    let totalGrocery = 0;
    let totalShares = 0;
    let totalToken = 0;
    let blockedRewards = 0;
    let detectedAndStopped = 0;

    for (let run = 0; run < Math.min(runs, strategyUsers); run++) {
      const noise = () => 0.8 + Math.random() * 0.4;

      const noisyParams = {
        ...params,
        postsPerMonth: Math.round(params.postsPerMonth * noise()),
        referralsPerMonth: Math.round(params.referralsPerMonth * noise()),
        streakDaysPerMonth: Math.min(30, Math.round(params.streakDaysPerMonth * noise())),
      };

      let effectiveMonths = months;

      if (Math.random() < params.detectionRisk) {
        effectiveMonths = Math.max(1, Math.floor(Math.random() * months));
        detectedAndStopped++;
      }

      const earnings = calculateAgentEarnings(noisyParams, slabs, effectiveMonths);

      const scale = strategyUsers / Math.min(runs, strategyUsers);

      totalGrocery += earnings.totalGrocery * scale;
      totalShares += earnings.totalShares * scale;
      totalToken += earnings.totalToken * scale;
      blockedRewards += earnings.blockedReferralRewards * scale;
    }

    const planAmount = parseInt(plan, 10);
    const revenue = strategyUsers * planAmount;
    const payoutINR = totalGrocery * 50 + totalShares * 100 + totalToken * 30;

    results[strategy] = {
      userCount: strategyUsers,
      detectedAndStopped,
      detectionRate: detectedAndStopped / Math.min(runs, strategyUsers),
      totalPayout: {
        groceryCoupons: Math.round(totalGrocery),
        shares: Math.round(totalShares),
        referralTokens: Math.round(totalToken),
        estimatedINR: Math.round(payoutINR),
      },
      blockedReferralRewardsINR: Math.round(blockedRewards),
      subscriptionRevenue: revenue,
      profitabilityRatio: revenue > 0
        ? Math.round(((revenue - payoutINR) / revenue) * 1000) / 1000
        : null,
    };
  }

  const totalPayout = Object.values(results).reduce((s, r) => s + r.totalPayout.estimatedINR, 0);
  const totalBlocked = Object.values(results).reduce((s, r) => s + r.blockedReferralRewardsINR, 0);
  const totalRevenue = parseInt(plan, 10) * totalUsers;

  return {
    config: { plan, totalUsers, months, runs },
    strategies: results,
    summary: {
      totalEstimatedPayoutINR: Math.round(totalPayout),
      totalBlockedReferralRewardsINR: Math.round(totalBlocked), // 🔥 KEY METRIC
      totalSubscriptionRevenue: totalRevenue,
      overallProfitabilityRatio: totalRevenue > 0
        ? Math.round(((totalRevenue - totalPayout) / totalRevenue) * 1000) / 1000
        : null,
    },
    simulatedAt: new Date().toISOString(),
  };
}

module.exports = { runSimulation, STRATEGIES };