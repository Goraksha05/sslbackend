/**
 * controllers/adsController.js
**/

'use strict';

const AdCampaign  = require('../models/AdCampaign');
const AdCreative  = require('../models/AdCreative');
const AdTargeting = require('../models/AdTargeting');
const AdAnalytics = require('../models/AdAnalytics');
const AdAccount   = require('../models/AdAccount');
const AdPage      = require('../models/AdPage');
const User        = require('../models/User');
const Profile     = require('../models/Profile');
const Activity    = require('../models/Activity');

const { getEligibleAds }  = require('../services/adEngine');
const notifyUser           = require('../utils/notifyUser');
const { writeAudit }       = require('../middleware/rbac');

// ─── Guard helpers ────────────────────────────────────────────────────────────

/**
 * Load and validate an Ad Account for the calling user.
 * Returns { account } or sends an error response.
 */
async function resolveActiveAccount(adAccountId, userId, res) {
  const account = await AdAccount.findOne({
    _id:       adAccountId,
    owner:     userId,
    isDeleted: false,
  }).lean();

  if (!account) {
    res.status(404).json({
      message: 'Ad Account not found. Please create an Ad Account first.',
      code:    'ACCOUNT_NOT_FOUND',
    });
    return null;
  }
  if (account.status !== 'active') {
    res.status(403).json({
      message: `Your Ad Account is not yet active (status: ${account.status}). ` +
               'You can only create campaigns from an approved, active Ad Account.',
      code:    'ACCOUNT_NOT_ACTIVE',
    });
    return null;
  }
  return account;
}

/**
 * Load and validate an Ad Page for a given account.
 */
async function resolveActivePage(adPageId, adAccountId, res) {
  const page = await AdPage.findOne({
    _id:       adPageId,
    adAccount: adAccountId,
    isDeleted: false,
  }).lean();

  if (!page) {
    res.status(404).json({
      message: 'Ad Page not found. Please create an Ad Page under this account.',
      code:    'PAGE_NOT_FOUND',
    });
    return null;
  }
  if (page.status !== 'active') {
    res.status(403).json({
      message: `The Ad Page is not active (status: ${page.status}).`,
      code:    'PAGE_NOT_ACTIVE',
    });
    return null;
  }
  return page;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADVERTISER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ads/campaign
 *
 * Required body fields:
 *   adAccountId  — the caller's active Ad Account
 *   adPageId     — an active Ad Page belonging to that account
 *   campaignName, budget, startDate, endDate
 *
 * Campaign is created with status 'pending_review' — admin must approve.
 */
exports.createCampaign = async (req, res) => {
  try {
    const {
      adAccountId, adPageId,
      campaignName, objective, budget, dailyBudget,
      bidPerClick, bidStrategy, startDate, endDate,
    } = req.body;

    // ── Hierarchy validation ────────────────────────────────────────────────
    if (!adAccountId) {
      return res.status(400).json({
        message: 'adAccountId is required. You must have an active Ad Account to create campaigns.',
        code:    'ACCOUNT_REQUIRED',
      });
    }
    if (!adPageId) {
      return res.status(400).json({
        message: 'adPageId is required. You must have an Ad Page to represent your brand on the campaign.',
        code:    'PAGE_REQUIRED',
      });
    }

    const account = await resolveActiveAccount(adAccountId, req.user.id, res);
    if (!account) return; // response already sent

    const page = await resolveActivePage(adPageId, account._id, res);
    if (!page) return; // response already sent

    // ── Field validation ────────────────────────────────────────────────────
    if (!campaignName?.trim()) {
      return res.status(400).json({ message: 'campaignName is required.', code: 'VALIDATION_ERROR' });
    }
    if (!budget || budget < 100) {
      return res.status(400).json({ message: 'Minimum budget is ₹100.', code: 'VALIDATION_ERROR' });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate are required.', code: 'VALIDATION_ERROR' });
    }

    const start = new Date(startDate);
    const end   = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: 'Invalid date format.', code: 'VALIDATION_ERROR' });
    }
    if (end <= start) {
      return res.status(400).json({ message: 'endDate must be after startDate.', code: 'VALIDATION_ERROR' });
    }
    if (start < new Date(Date.now() - 60_000)) {
      return res.status(400).json({ message: 'startDate cannot be in the past.', code: 'VALIDATION_ERROR' });
    }

    // ── Check account spend cap ─────────────────────────────────────────────
    if (account.lifetimeSpendCapINR && (account.totalSpentINR + budget) > account.lifetimeSpendCapINR) {
      return res.status(400).json({
        message: `This campaign budget (₹${budget}) would exceed your account spend cap (₹${account.lifetimeSpendCapINR}).`,
        code:    'SPEND_CAP_EXCEEDED',
      });
    }

    const campaign = await AdCampaign.create({
      adAccount:       account._id,
      adPage:          page._id,
      user_id:         req.user.id,
      campaignName:    campaignName.trim(),
      objective:       objective    || 'traffic',
      budget,
      remainingBudget: budget,
      dailyBudget:     dailyBudget  || null,
      bidPerClick:     bidPerClick  || 1,
      bidStrategy:     bidStrategy  || 'manual_cpc',
      startDate:       start,
      endDate:         end,
      status:          'pending_review', // always starts here — admin approves
    });

    return res.status(201).json({
      message:  'Campaign submitted for review. It will start serving once approved by our team.',
      campaign: {
        _id:          campaign._id,
        campaignName: campaign.campaignName,
        status:       campaign.status,
        adAccountId:  account._id,
        adPageId:     page._id,
        budget,
        startDate:    campaign.startDate,
        endDate:      campaign.endDate,
      },
    });
  } catch (err) {
    console.error('[createCampaign]', err);
    return res.status(500).json({ message: 'Failed to create campaign.', code: 'SERVER_ERROR' });
  }
};

/**
 * POST /api/ads/creative
 * Add a creative to a campaign.
 * Campaign must belong to the caller and must not be rejected.
 */
exports.addCreative = async (req, res) => {
  try {
    const { campaign_id, image, video, text, cta, link, mediaType, altText } = req.body;

    if (!campaign_id) {
      return res.status(400).json({ message: 'campaign_id is required.', code: 'VALIDATION_ERROR' });
    }

    const campaign = await AdCampaign.findOne({
      _id:     campaign_id,
      user_id: req.user.id,
      status:  { $ne: 'rejected' },
    }).lean();
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found or not yours.', code: 'NOT_FOUND' });
    }

    if (!link || !/^https:\/\//i.test(link)) {
      return res.status(400).json({ message: 'link must be a valid HTTPS URL.', code: 'VALIDATION_ERROR' });
    }

    const creative = await AdCreative.create({
      campaign_id,
      mediaType: mediaType || 'image',
      image:     image   || null,
      video:     video   || null,
      text:      text    || '',
      cta:       cta     || '',
      link,
      altText:   altText || '',
    });

    return res.status(201).json(creative);
  } catch (err) {
    console.error('[addCreative]', err);
    return res.status(500).json({ message: 'Failed to add creative.', code: 'SERVER_ERROR' });
  }
};

/**
 * POST /api/ads/targeting
 */
exports.setTargeting = async (req, res) => {
  try {
    const { campaign_id } = req.body;

    if (!campaign_id) {
      return res.status(400).json({ message: 'campaign_id is required.', code: 'VALIDATION_ERROR' });
    }

    const campaign = await AdCampaign.findOne({ _id: campaign_id, user_id: req.user.id }).lean();
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found or not yours.', code: 'NOT_FOUND' });
    }

    const targeting = await AdTargeting.findOneAndUpdate(
      { campaign_id },
      { ...req.body },
      { upsert: true, new: true, runValidators: true }
    );

    return res.json(targeting);
  } catch (err) {
    console.error('[setTargeting]', err);
    return res.status(500).json({ message: 'Failed to set targeting.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/my-campaigns
 * Optionally filter by adAccountId.
 */
exports.getMyCampaigns = async (req, res) => {
  try {
    const page   = Math.max(1,  parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 10);
    const skip   = (page - 1) * limit;

    const filter = { user_id: req.user.id };
    if (req.query.status)     filter.status     = req.query.status;
    if (req.query.adAccountId) filter.adAccount = req.query.adAccountId;

    const [campaigns, total] = await Promise.all([
      AdCampaign.find(filter)
        .populate('adAccount', 'accountName accountId status')
        .populate('adPage',    'pageName logoUrl pageSlug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdCampaign.countDocuments(filter),
    ]);

    return res.json({
      campaigns,
      pagination: { page, pages: Math.ceil(total / limit), total },
    });
  } catch (err) {
    console.error('[getMyCampaigns]', err);
    return res.status(500).json({ message: 'Failed to fetch campaigns.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/campaign/:id/analytics
 */
exports.getCampaignAnalytics = async (req, res) => {
  try {
    const campaign = await AdCampaign.findOne({
      _id:     req.params.id,
      user_id: req.user.id,
    })
      .populate('adPage', 'pageName logoUrl')
      .lean();

    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.', code: 'NOT_FOUND' });
    }

    const creatives   = await AdCreative.find({ campaign_id: campaign._id }).lean();
    const creativeIds = creatives.map(c => c._id);
    const analyticsArr = await AdAnalytics.find({ ad_id: { $in: creativeIds } }).lean();

    const analyticsMap = Object.fromEntries(analyticsArr.map(a => [String(a.ad_id), a]));
    const enriched = creatives.map(c => ({
      ...c,
      analytics: analyticsMap[String(c._id)] || { impressions: 0, clicks: 0, totalSpentINR: 0 },
    }));

    return res.json({ campaign, creatives: enriched });
  } catch (err) {
    console.error('[getCampaignAnalytics]', err);
    return res.status(500).json({ message: 'Failed to fetch analytics.', code: 'SERVER_ERROR' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// AD SERVING
// ═══════════════════════════════════════════════════════════════════════════

exports.getAdsForUser = async (req, res) => {
  try {
    const userId = req.user.id;

    const [profile, streakCount] = await Promise.all([
      Profile.findOne({ user_id: userId }).select('currentcity hometown sex').lean(),
      Activity.countDocuments({ user: userId, dailystreak: { $exists: true, $ne: null } }),
    ]);

    const userContext = {
      ...req.user,
      currentcity: profile?.currentcity || '',
      hometown:    profile?.hometown    || '',
      sex:         profile?.sex         || null,
      streakDays:  streakCount,
    };

    const ads = await getEligibleAds(userContext, {
      limit:   parseInt(req.query.limit) || 5,
      context: req.query.context || 'feed',
    });

    // Enrich each ad with its page info so the feed can show the sponsor brand
    const campaignIds = [...new Set(ads.map(a => String(a.campaignId)))];
    const campaigns   = await AdCampaign.find({ _id: { $in: campaignIds } })
      .populate('adPage', 'pageName logoUrl tagline pageSlug website')
      .lean();
    const campaignMap = Object.fromEntries(campaigns.map(c => [String(c._id), c]));

    const enrichedAds = ads.map(ad => ({
      ...ad,
      adPage: campaignMap[String(ad.campaignId)]?.adPage || null,
    }));

    return res.json({ ads: enrichedAds, count: enrichedAds.length });
  } catch (err) {
    console.error('[getAdsForUser]', err);
    return res.status(500).json({ message: 'Failed to fetch ads.', code: 'SERVER_ERROR' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// AD TRACKING
// ═══════════════════════════════════════════════════════════════════════════

exports.trackImpression = async (req, res) => {
  res.status(202).json({ ok: true });

  try {
    const { ad_id } = req.body;
    if (!ad_id) return;

    let analytics = await AdAnalytics.findOne({ ad_id });
    if (!analytics) {
      analytics = new AdAnalytics({ ad_id });
    }
    analytics.recordEvent('impression');
    await analytics.save();

    AdCreative.findByIdAndUpdate(ad_id, { $inc: { impressionCount: 1 } }).catch(() => {});

    // Also sync to AdPage stats (denormalised)
    const creative = await AdCreative.findById(ad_id).lean();
    if (creative) {
      const campaign = await AdCampaign.findById(creative.campaign_id).lean();
      if (campaign?.adPage) {
        AdPage.findByIdAndUpdate(campaign.adPage, { $inc: { totalImpressions: 1 } }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[trackImpression]', err.message);
  }
};

exports.trackClick = async (req, res) => {
  res.status(202).json({ ok: true });

  try {
    const { ad_id } = req.body;
    if (!ad_id) return;

    const creative = await AdCreative.findById(ad_id).populate('campaign_id').lean();
    if (!creative) return;

    const campaign = creative.campaign_id;
    if (!campaign) return;

    const cost = campaign.bidPerClick || 1;

    let analytics = await AdAnalytics.findOne({ ad_id });
    if (!analytics) {
      analytics = new AdAnalytics({ ad_id, campaign_id: campaign._id });
    }
    analytics.recordEvent('click', cost);
    await analytics.save();

    const updated = await AdCampaign.findOneAndUpdate(
      { _id: campaign._id, remainingBudget: { $gte: cost }, status: 'active' },
      { $inc: { remainingBudget: -cost, totalSpent: cost, clickCount: 1 } },
      { new: true }
    );

    if (!updated) {
      await AdCampaign.findByIdAndUpdate(campaign._id, {
        $set: { status: 'paused', pauseReason: 'Budget exhausted' }
      });
      setImmediate(() => {
        notifyUser(
          campaign.user_id,
          `⚠️ Your campaign "${campaign.campaignName}" has been paused — budget exhausted.`,
          'custom',
          { url: '/ads/manager' }
        ).catch(() => {});
      });
    } else {
      AdCreative.findByIdAndUpdate(ad_id, { $inc: { clickCount: 1 } }).catch(() => {});

      // Update AdAccount spend + AdPage click stats
      if (campaign.adPage) {
        AdPage.findByIdAndUpdate(campaign.adPage, { $inc: { totalClicks: 1 } }).catch(() => {});
      }
      // Update AdAccount total spend
      AdAccount.findByIdAndUpdate(campaign.adAccount, {
        $inc: { totalSpentINR: cost }
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[trackClick]', err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN — Campaign management
// ═══════════════════════════════════════════════════════════════════════════

exports.listAllCampaigns = async (req, res) => {
  try {
    const page   = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 25);
    const skip   = (page - 1) * limit;

    const filter = {};
    if (req.query.status)  filter.status  = req.query.status;
    if (req.query.userId)  filter.user_id = req.query.userId;
    if (req.query.adAccountId) filter.adAccount = req.query.adAccountId;

    const [campaigns, total] = await Promise.all([
      AdCampaign.find(filter)
        .populate({ path: 'user_id',    select: 'name email username' })
        .populate({ path: 'adAccount',  select: 'accountName accountId status' })
        .populate({ path: 'adPage',     select: 'pageName logoUrl pageSlug' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdCampaign.countDocuments(filter),
    ]);

    return res.json({
      campaigns,
      pagination: { page, pages: Math.ceil(total / limit), total },
    });
  } catch (err) {
    console.error('[listAllCampaigns]', err);
    return res.status(500).json({ message: 'Failed to list campaigns.', code: 'SERVER_ERROR' });
  }
};

exports.updateCampaignStatus = async (req, res) => {
  try {
    const { status, rejectionNote } = req.body;
    const VALID = ['active', 'paused', 'rejected'];

    if (!VALID.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${VALID.join(', ')}`,
        code:    'VALIDATION_ERROR',
      });
    }

    const campaign = await AdCampaign.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status,
          reviewedBy:    req.user.id,
          reviewedAt:    new Date(),
          rejectionNote: rejectionNote || null,
          approvedAt:    status === 'active' ? new Date() : null,
          ...(status === 'paused' && { pauseReason: rejectionNote || 'Admin action' }),
        },
      },
      { new: true }
    );

    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.', code: 'NOT_FOUND' });
    }

    const msg = status === 'rejected'
      ? `❌ Your campaign "${campaign.campaignName}" was rejected. Reason: ${rejectionNote || 'Policy violation'}`
      : status === 'paused'
      ? `⏸️ Your campaign "${campaign.campaignName}" has been paused.`
      : `✅ Your campaign "${campaign.campaignName}" is now live and serving ads!`;

    setImmediate(() => {
      notifyUser(campaign.user_id, msg, 'custom', { url: '/ads/manager' }).catch(() => {});
    });

    await writeAudit(req, 'ad_campaign_status_change', {
      campaignId:    String(campaign._id),
      campaignName:  campaign.campaignName,
      status,
      rejectionNote: rejectionNote || null,
    });

    return res.json({ campaign });
  } catch (err) {
    console.error('[updateCampaignStatus]', err);
    return res.status(500).json({ message: 'Failed to update campaign status.', code: 'SERVER_ERROR' });
  }
};

// GET /api/ads/account/my
exports.getMyAdAccounts = async (req, res) => {
  try {
    const accounts = await AdAccount.find({
      owner: req.user.id,
      isDeleted: false
    }).lean();

    res.json({ accounts });
  } catch (err) {
    console.error('[getMyAdAccounts]', err);
    res.status(500).json({ message: 'Failed to fetch accounts' });
  }
};