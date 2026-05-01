/**
 * services/adEngine.js
**/

'use strict';

const AdCampaign   = require('../models/AdCampaign');
const AdCreative   = require('../models/AdCreative');
const AdTargeting  = require('../models/AdTargeting');
const AdAnalytics  = require('../models/AdAnalytics');

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_ADS         = 5;
const EXPLORATION_CTR = 0.10; // assumed CTR for new (zero-impression) ads

// ── Targeting matcher ─────────────────────────────────────────────────────────
/**
 * @param {object} user      - req.user (from fetchuser) + profile fields merged in
 * @param {object} targeting - AdTargeting document
 * @returns {boolean}
 */
function matchTargeting(user, targeting) {
  if (!targeting) return true; // no targeting = show to everyone

  // ── Age ────────────────────────────────────────────────────────────────────
  // `user.age` must be provided by the caller from the User/Profile document.
  if (targeting.ageMin != null && user.age != null && user.age < targeting.ageMin) return false;
  if (targeting.ageMax != null && user.age != null && user.age > targeting.ageMax) return false;

  // ── Gender ─────────────────────────────────────────────────────────────────
  if (targeting.genders?.length && user.sex) {
    if (!targeting.genders.includes(user.sex)) return false;
  }

  // ── Geography (currentcity OR hometown from Profile) ──────────────────────
  if (targeting.cities?.length) {
    const userCity = user.currentcity || user.hometown || '';
    if (!targeting.cities.some(c => c.toLowerCase() === userCity.toLowerCase())) return false;
  }

  // ── Interests ─────────────────────────────────────────────────────────────
  if (targeting.interests?.length && user.interests?.length) {
    const match = targeting.interests.some(i => user.interests.includes(i));
    if (!match) return false;
  }

  // ── Platform gates ─────────────────────────────────────────────────────────
  // Subscription plan filter
  if (targeting.subscriptionPlans?.length) {
    const userPlan = user.subscription?.planAmount;
    if (!targeting.subscriptionPlans.includes(userPlan)) return false;
  }

  // KYC gate
  if (targeting.kycVerifiedOnly && user.kyc?.status !== 'verified') return false;

  // Minimum streak gate (requires caller to pass user.streakDays)
  if (targeting.minStreakDays && (user.streakDays ?? 0) < targeting.minStreakDays) return false;

  return true;
}

// ── Score calculator ──────────────────────────────────────────────────────────
/**
 * eCPM-style score:  bidPerClick × effective_CTR
 * New ads get EXPLORATION_CTR so they're not buried on day one.
 */
function calculateScore(campaign, analytics) {
  const ctr = analytics.impressions > 0
    ? analytics.clicks / analytics.impressions
    : EXPLORATION_CTR;

  return campaign.bidPerClick * ctr;
}

// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Return up to MAX_ADS ranked ad objects for a given user context.
 *
 * @param {object} user     — req.user merged with Profile fields
 * @param {object} [opts]
 * @param {number} [opts.limit]   — override MAX_ADS
 * @param {string} [opts.context] — 'feed' | 'profile' | 'sidebar' (for future use)
 * @returns {Promise<object[]>}
 */
async function getEligibleAds(user, opts = {}) {
  const limit = opts.limit ?? MAX_ADS;
  const now   = new Date();

  // ── Step 1: fetch active campaigns in one query ───────────────────────────
  const campaigns = await AdCampaign.find({
    status:          'active',
    remainingBudget: { $gt: 0 },
    startDate:       { $lte: now },
    endDate:         { $gte: now },
  }).lean();

  if (!campaigns.length) return [];

  const campaignIds = campaigns.map(c => c._id);

  // ── Step 2: batch-fetch targeting + creatives in parallel ────────────────
  const [allTargeting, allCreatives] = await Promise.all([
    AdTargeting.find({ campaign_id: { $in: campaignIds } }).lean(),
    AdCreative.find({ campaign_id: { $in: campaignIds }, status: 'active' }).lean(),
  ]);

  // Index by campaign_id for O(1) lookup
  const targetingMap = Object.fromEntries(
    allTargeting.map(t => [String(t.campaign_id), t])
  );

  // Group creatives by campaign
  const creativesByCampaign = {};
  for (const c of allCreatives) {
    const cid = String(c.campaign_id);
    if (!creativesByCampaign[cid]) creativesByCampaign[cid] = [];
    creativesByCampaign[cid].push(c);
  }

  // ── Step 3: filter campaigns by targeting ─────────────────────────────────
  const eligibleCreatives = [];
  for (const campaign of campaigns) {
    const cid      = String(campaign._id);
    const targeting = targetingMap[cid] || null;
    if (!matchTargeting(user, targeting)) continue;

    const creatives = creativesByCampaign[cid] || [];
    for (const creative of creatives) {
      eligibleCreatives.push({ campaign, creative });
    }
  }

  if (!eligibleCreatives.length) return [];

  // ── Step 4: batch-fetch analytics for all eligible creatives ─────────────
  const creativeIds = eligibleCreatives.map(({ creative }) => creative._id);
  const analyticsArr = await AdAnalytics.find({ ad_id: { $in: creativeIds } }).lean();
  const analyticsMap = Object.fromEntries(
    analyticsArr.map(a => [String(a.ad_id), a])
  );

  // ── Step 5: score and rank ────────────────────────────────────────────────
  const scored = eligibleCreatives.map(({ campaign, creative }) => {
    const analytics = analyticsMap[String(creative._id)] || { impressions: 0, clicks: 0 };
    return {
      _id:        creative._id,
      campaignId: campaign._id,
      image:      creative.image,
      video:      creative.video,
      text:       creative.text,
      cta:        creative.cta,
      link:       creative.link,
      mediaType:  creative.mediaType,
      objective:  campaign.objective,
      score:      calculateScore(campaign, analytics),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { getEligibleAds, matchTargeting, calculateScore };