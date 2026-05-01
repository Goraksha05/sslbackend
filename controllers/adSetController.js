/**
 * controllers/adSetController.js
 *
 * Full CRUD for Ad Sets.
 *
 * Routes (mounted in adsRoutes.js):
 *   POST   /api/ads/adset                          — create an ad set
 *   GET    /api/ads/campaign/:campaignId/adsets     — list sets for campaign
 *   GET    /api/ads/adset/:adSetId                 — get single ad set
 *   PATCH  /api/ads/adset/:adSetId                 — update ad set
 *   DELETE /api/ads/adset/:adSetId                 — soft delete
 *
 * Ad (Creative) routes under an Ad Set:
 *   POST   /api/ads/adset/:adSetId/ad              — create an ad
 *   GET    /api/ads/adset/:adSetId/ads             — list ads in a set
 *   GET    /api/ads/ad/:adId                       — get single ad
 *   PATCH  /api/ads/ad/:adId                       — update ad
 *   DELETE /api/ads/ad/:adId                       — soft delete ad
 */

'use strict';

const mongoose    = require('mongoose');
const AdSet       = require('../models/AdSet');
const AdCreative  = require('../models/AdCreative');
const AdCampaign  = require('../models/AdCampaign');
const AdAccount   = require('../models/AdAccount');
const AdAnalytics = require('../models/AdAnalytics');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Load a campaign that belongs to the calling user.
 */
async function loadOwnCampaign(campaignId, userId) {
  return AdCampaign.findOne({
    _id:     campaignId,
    user_id: userId,
    status:  { $ne: 'rejected' },
  }).lean();
}

/**
 * Load an ad set that belongs to the calling user.
 */
async function loadOwnAdSet(adSetId, userId) {
  return AdSet.findOne({
    _id:       adSetId,
    owner:     userId,
    isDeleted: false,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AD SET — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ads/adset
 *
 * Required body:
 *   campaignId, name, startDate, endDate
 *
 * Optional:
 *   targeting, placements, dailyBudgetCap, bidPerClick, dayParting
 */
exports.createAdSet = async (req, res) => {
  try {
    const {
      campaignId,
      name,
      targeting   = {},
      placements  = ['feed'],
      startDate,
      endDate,
      dailyBudgetCap = null,
      bidPerClick    = null,
      dayParting     = [],
    } = req.body;

    if (!campaignId || !isValidId(campaignId)) {
      return res.status(400).json({ message: 'Valid campaignId required.', code: 'VALIDATION_ERROR' });
    }
    if (!name?.trim()) {
      return res.status(400).json({ message: 'Ad set name required.', code: 'VALIDATION_ERROR' });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate required.', code: 'VALIDATION_ERROR' });
    }

    const start = new Date(startDate);
    const end   = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({ message: 'Invalid date range.', code: 'VALIDATION_ERROR' });
    }

    const campaign = await loadOwnCampaign(campaignId, req.user.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found or not yours.', code: 'NOT_FOUND' });
    }

    // Max 20 ad sets per campaign
    const setCount = await AdSet.countDocuments({ campaign: campaignId, isDeleted: false });
    if (setCount >= 20) {
      return res.status(429).json({ message: 'Maximum 20 ad sets per campaign.', code: 'LIMIT_REACHED' });
    }

    const adSet = await AdSet.create({
      campaign:      campaignId,
      adAccount:     campaign.adAccount,
      owner:         req.user.id,
      name:          name.trim(),
      targeting,
      placements,
      startDate:     start,
      endDate:       end,
      dailyBudgetCap,
      bidPerClick,
      dayParting,
      status:        'active',
    });

    return res.status(201).json({
      message: 'Ad set created.',
      adSet,
    });
  } catch (err) {
    console.error('[createAdSet]', err);
    return res.status(500).json({ message: 'Failed to create ad set.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/campaign/:campaignId/adsets
 * List all ad sets for a campaign with their ad counts.
 */
exports.listAdSets = async (req, res) => {
  try {
    const { campaignId } = req.params;
    if (!isValidId(campaignId)) {
      return res.status(400).json({ message: 'Invalid campaignId.', code: 'VALIDATION_ERROR' });
    }

    const campaign = await loadOwnCampaign(campaignId, req.user.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.', code: 'NOT_FOUND' });
    }

    const adSets = await AdSet.find({ campaign: campaignId, isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();

    // Attach per-set ad counts
    const setIds = adSets.map(s => s._id);
    const adCounts = await AdCreative.aggregate([
      { $match: { adSet: { $in: setIds }, status: { $ne: 'rejected' } } },
      { $group: { _id: '$adSet', count: { $sum: 1 } } },
    ]);
    const adCountMap = Object.fromEntries(adCounts.map(a => [String(a._id), a.count]));

    const enriched = adSets.map(s => ({
      ...s,
      adCount: adCountMap[String(s._id)] || 0,
    }));

    return res.json({ adSets: enriched, total: enriched.length });
  } catch (err) {
    console.error('[listAdSets]', err);
    return res.status(500).json({ message: 'Failed to fetch ad sets.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/adset/:adSetId
 * Get a single ad set with all its ads.
 */
exports.getAdSet = async (req, res) => {
  try {
    const { adSetId } = req.params;
    if (!isValidId(adSetId)) {
      return res.status(400).json({ message: 'Invalid adSetId.', code: 'VALIDATION_ERROR' });
    }

    const adSet = await loadOwnAdSet(adSetId, req.user.id);
    if (!adSet) {
      return res.status(404).json({ message: 'Ad set not found.', code: 'NOT_FOUND' });
    }

    const ads = await AdCreative.find({ adSet: adSetId, status: { $ne: 'rejected' } })
      .sort({ createdAt: -1 })
      .lean();

    // Attach analytics to each ad
    const adIds = ads.map(a => a._id);
    const analyticsArr = await AdAnalytics.find({ ad_id: { $in: adIds } }).lean();
    const analyticsMap = Object.fromEntries(analyticsArr.map(a => [String(a.ad_id), a]));

    const enrichedAds = ads.map(ad => ({
      ...ad,
      analytics: analyticsMap[String(ad._id)] || { impressions: 0, clicks: 0, totalSpentINR: 0 },
    }));

    return res.json({ adSet, ads: enrichedAds });
  } catch (err) {
    console.error('[getAdSet]', err);
    return res.status(500).json({ message: 'Failed to fetch ad set.', code: 'SERVER_ERROR' });
  }
};

/**
 * PATCH /api/ads/adset/:adSetId
 */
exports.updateAdSet = async (req, res) => {
  try {
    const { adSetId } = req.params;
    if (!isValidId(adSetId)) {
      return res.status(400).json({ message: 'Invalid adSetId.', code: 'VALIDATION_ERROR' });
    }

    const adSet = await loadOwnAdSet(adSetId, req.user.id);
    if (!adSet) {
      return res.status(404).json({ message: 'Ad set not found.', code: 'NOT_FOUND' });
    }

    const allowed = ['name', 'targeting', 'placements', 'startDate', 'endDate',
                     'dailyBudgetCap', 'bidPerClick', 'dayParting', 'status'];

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        adSet[field] = req.body[field];
      }
    }

    await adSet.save();
    return res.json({ message: 'Ad set updated.', adSet });
  } catch (err) {
    console.error('[updateAdSet]', err);
    return res.status(500).json({ message: 'Failed to update ad set.', code: 'SERVER_ERROR' });
  }
};

/**
 * DELETE /api/ads/adset/:adSetId
 */
exports.deleteAdSet = async (req, res) => {
  try {
    const { adSetId } = req.params;
    if (!isValidId(adSetId)) {
      return res.status(400).json({ message: 'Invalid adSetId.', code: 'VALIDATION_ERROR' });
    }

    const adSet = await loadOwnAdSet(adSetId, req.user.id);
    if (!adSet) {
      return res.status(404).json({ message: 'Ad set not found.', code: 'NOT_FOUND' });
    }

    adSet.isDeleted = true;
    adSet.status    = 'paused';
    await adSet.save();

    // Soft-pause all ads in this set
    await AdCreative.updateMany(
      { adSet: adSetId },
      { $set: { status: 'paused' } }
    );

    return res.json({ message: 'Ad set deleted.' });
  } catch (err) {
    console.error('[deleteAdSet]', err);
    return res.status(500).json({ message: 'Failed to delete ad set.', code: 'SERVER_ERROR' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADS (CREATIVES) — CRUD under AdSet
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ads/adset/:adSetId/ad
 *
 * Create a new Ad (Creative) within an Ad Set.
 *
 * Required body: adName, link
 * Optional:      format, mediaType, image, video, text, headline, description,
 *                cta, altText, carouselCards, tracking
 */
exports.createAd = async (req, res) => {
  try {
    const { adSetId } = req.params;
    if (!isValidId(adSetId)) {
      return res.status(400).json({ message: 'Invalid adSetId.', code: 'VALIDATION_ERROR' });
    }

    const adSet = await loadOwnAdSet(adSetId, req.user.id);
    if (!adSet) {
      return res.status(404).json({ message: 'Ad set not found.', code: 'NOT_FOUND' });
    }

    const {
      adName       = '',
      format       = 'single_image',
      mediaType    = 'image',
      image        = null,
      video        = null,
      previewUrl   = null,
      text         = '',
      headline     = '',
      description  = '',
      cta          = '',
      altText      = '',
      link,
      carouselCards = [],
      tracking     = {},
    } = req.body;

    if (!link || !/^https:\/\//i.test(link)) {
      return res.status(400).json({ message: 'link must be a valid HTTPS URL.', code: 'VALIDATION_ERROR' });
    }

    // Max 50 ads per set
    const adCount = await AdCreative.countDocuments({ adSet: adSetId, status: { $ne: 'rejected' } });
    if (adCount >= 50) {
      return res.status(429).json({ message: 'Maximum 50 ads per ad set.', code: 'LIMIT_REACHED' });
    }

    const ad = await AdCreative.create({
      adSet:        adSetId,
      campaign_id:  adSet.campaign,
      adAccount:    adSet.adAccount,
      adName:       adName.trim(),
      format,
      mediaType,
      image,
      video,
      previewUrl,
      text,
      headline,
      description,
      cta,
      altText,
      link,
      carouselCards,
      tracking,
      status: 'active',
    });

    // Update denormalised adCount on set
    await AdSet.findByIdAndUpdate(adSetId, { $inc: { adCount: 1 } });

    // Ensure analytics doc exists
    await AdAnalytics.findOneAndUpdate(
      { ad_id: ad._id },
      { $setOnInsert: { ad_id: ad._id, campaign_id: adSet.campaign } },
      { upsert: true, new: true }
    );

    return res.status(201).json({ message: 'Ad created.', ad });
  } catch (err) {
    console.error('[createAd]', err);
    return res.status(500).json({ message: 'Failed to create ad.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/adset/:adSetId/ads
 * List all ads in an ad set with their analytics.
 */
exports.listAds = async (req, res) => {
  try {
    const { adSetId } = req.params;
    if (!isValidId(adSetId)) {
      return res.status(400).json({ message: 'Invalid adSetId.', code: 'VALIDATION_ERROR' });
    }

    const adSet = await loadOwnAdSet(adSetId, req.user.id);
    if (!adSet) {
      return res.status(404).json({ message: 'Ad set not found.', code: 'NOT_FOUND' });
    }

    const page   = Math.max(1,  parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;

    const filter = { adSet: adSetId };
    if (req.query.status) filter.status = req.query.status;

    const [ads, total] = await Promise.all([
      AdCreative.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdCreative.countDocuments(filter),
    ]);

    const adIds = ads.map(a => a._id);
    const analyticsArr = await AdAnalytics.find({ ad_id: { $in: adIds } }).lean();
    const analyticsMap = Object.fromEntries(analyticsArr.map(a => [String(a.ad_id), a]));

    const enriched = ads.map(ad => ({
      ...ad,
      analytics: analyticsMap[String(ad._id)] || { impressions: 0, clicks: 0, totalSpentINR: 0 },
    }));

    return res.json({
      ads: enriched,
      pagination: { page, pages: Math.ceil(total / limit), total },
    });
  } catch (err) {
    console.error('[listAds]', err);
    return res.status(500).json({ message: 'Failed to list ads.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/ad/:adId
 */
exports.getAd = async (req, res) => {
  try {
    const { adId } = req.params;
    if (!isValidId(adId)) {
      return res.status(400).json({ message: 'Invalid adId.', code: 'VALIDATION_ERROR' });
    }

    const ad = await AdCreative.findOne({ _id: adId }).lean();
    if (!ad || ad.adSet?.owner?.toString() !== req.user.id) {
      // Ownership check via set
      const adSet = await AdSet.findOne({ _id: ad?.adSet, owner: req.user.id }).lean();
      if (!adSet) {
        return res.status(404).json({ message: 'Ad not found.', code: 'NOT_FOUND' });
      }
    }

    const analytics = await AdAnalytics.findOne({ ad_id: adId }).lean();

    return res.json({ ad, analytics: analytics || { impressions: 0, clicks: 0 } });
  } catch (err) {
    console.error('[getAd]', err);
    return res.status(500).json({ message: 'Failed to fetch ad.', code: 'SERVER_ERROR' });
  }
};

/**
 * PATCH /api/ads/ad/:adId
 */
exports.updateAd = async (req, res) => {
  try {
    const { adId } = req.params;
    if (!isValidId(adId)) {
      return res.status(400).json({ message: 'Invalid adId.', code: 'VALIDATION_ERROR' });
    }

    const ad = await AdCreative.findById(adId);
    if (!ad) {
      return res.status(404).json({ message: 'Ad not found.', code: 'NOT_FOUND' });
    }

    // Verify ownership via adSet
    const adSet = await AdSet.findOne({ _id: ad.adSet, owner: req.user.id, isDeleted: false }).lean();
    if (!adSet) {
      return res.status(403).json({ message: 'Not authorised.', code: 'FORBIDDEN' });
    }

    const allowed = ['adName', 'format', 'mediaType', 'image', 'video', 'previewUrl',
                     'text', 'headline', 'description', 'cta', 'altText',
                     'link', 'carouselCards', 'tracking', 'status'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) ad[field] = req.body[field];
    }

    await ad.save();
    return res.json({ message: 'Ad updated.', ad });
  } catch (err) {
    console.error('[updateAd]', err);
    return res.status(500).json({ message: 'Failed to update ad.', code: 'SERVER_ERROR' });
  }
};

/**
 * DELETE /api/ads/ad/:adId
 */
exports.deleteAd = async (req, res) => {
  try {
    const { adId } = req.params;
    if (!isValidId(adId)) {
      return res.status(400).json({ message: 'Invalid adId.', code: 'VALIDATION_ERROR' });
    }

    const ad = await AdCreative.findById(adId);
    if (!ad) {
      return res.status(404).json({ message: 'Ad not found.', code: 'NOT_FOUND' });
    }

    const adSet = await AdSet.findOne({ _id: ad.adSet, owner: req.user.id, isDeleted: false }).lean();
    if (!adSet) {
      return res.status(403).json({ message: 'Not authorised.', code: 'FORBIDDEN' });
    }

    ad.status = 'rejected';
    await ad.save();

    await AdSet.findByIdAndUpdate(ad.adSet, { $inc: { adCount: -1 } });

    return res.json({ message: 'Ad deleted.' });
  } catch (err) {
    console.error('[deleteAd]', err);
    return res.status(500).json({ message: 'Failed to delete ad.', code: 'SERVER_ERROR' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FULL HIERARCHY FETCH — for campaign detail view
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/ads/campaign/:campaignId/hierarchy
 * Returns the full Campaign → AdSets → Ads tree in one request.
 * Suitable for rendering the complete campaign detail drawer.
 */
exports.getCampaignHierarchy = async (req, res) => {
  try {
    const { campaignId } = req.params;
    if (!isValidId(campaignId)) {
      return res.status(400).json({ message: 'Invalid campaignId.', code: 'VALIDATION_ERROR' });
    }

    const campaign = await loadOwnCampaign(campaignId, req.user.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.', code: 'NOT_FOUND' });
    }

    const adSets = await AdSet.find({ campaign: campaignId, isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();

    const setIds = adSets.map(s => s._id);

    const [ads, analyticsArr] = await Promise.all([
      AdCreative.find({ adSet: { $in: setIds }, status: { $ne: 'rejected' } })
        .sort({ createdAt: -1 })
        .lean(),
      AdAnalytics.find({
        ad_id: {
          $in: await AdCreative.distinct('_id', { adSet: { $in: setIds } }),
        },
      }).lean(),
    ]);

    const analyticsMap = Object.fromEntries(analyticsArr.map(a => [String(a.ad_id), a]));

    // Group ads by adSet
    const adsBySet = {};
    for (const ad of ads) {
      const sid = String(ad.adSet);
      if (!adsBySet[sid]) adsBySet[sid] = [];
      adsBySet[sid].push({
        ...ad,
        analytics: analyticsMap[String(ad._id)] || { impressions: 0, clicks: 0, totalSpentINR: 0 },
      });
    }

    const hierarchy = adSets.map(s => ({
      ...s,
      ads: adsBySet[String(s._id)] || [],
    }));

    return res.json({ campaign, adSets: hierarchy });
  } catch (err) {
    console.error('[getCampaignHierarchy]', err);
    return res.status(500).json({ message: 'Failed to fetch hierarchy.', code: 'SERVER_ERROR' });
  }
};