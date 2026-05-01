/**
 * routes/adsRoutes.js  (UPDATED)
 *
 * Full advertising hierarchy:
 *   AdAccount → AdCampaign → AdSet → AdCreative (Ad)
 *
 * Mount in index.js:
 *   app.use('/api/ads', require('./routes/adsRoutes'));
 *
 * NEW routes added:
 *   POST   /adset                              — create ad set
 *   GET    /campaign/:campaignId/adsets        — list ad sets
 *   GET    /campaign/:campaignId/hierarchy     — full Campaign→AdSets→Ads tree
 *   GET    /adset/:adSetId                     — get single ad set + ads
 *   PATCH  /adset/:adSetId                     — update ad set
 *   DELETE /adset/:adSetId                     — soft delete ad set
 *
 *   POST   /adset/:adSetId/ad                  — create an ad
 *   GET    /adset/:adSetId/ads                 — list ads in a set
 *   GET    /ad/:adId                           — get single ad
 *   PATCH  /ad/:adId                           — update ad
 *   DELETE /ad/:adId                           — delete ad
 */

'use strict';

const express   = require('express');
const { body, param, query } = require('express-validator');
const { validationResult } = require('express-validator');
const router    = express.Router();

const fetchUser   = require('../middleware/fetchuser');
const { verifyAdmin, checkPermission } = require('../middleware/rbac');

const ctrl        = require('../controllers/adsController');
const adSetCtrl   = require('../controllers/adSetController');
const adAccountController  = require('../controllers/adAccountController');

// ── Inline validation helper ──────────────────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Validation failed.', errors: errors.array() });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════════════════
// AD ACCOUNT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/ads/pages/my — flat list of ALL pages for the current user ───────
// MUST be declared before any /:param routes so Express does not treat
// literal path segments ("pages") as parameter values.
router.get('/pages/my', fetchUser, adAccountController.getMyPages);

// ── Page-scoped routes (/page/:pageId/...) ─────────────────────────────────
// These must also come before any generic /:param catch-all routes.
router.get(
  '/page/:pageId/campaigns',
  fetchUser,
  [param('pageId').isMongoId().withMessage('Invalid pageId')],
  validate,
  adAccountController.getPageCampaigns
);

router.get(
  '/page/:pageId/feed',
  fetchUser,
  [param('pageId').isMongoId().withMessage('Invalid pageId')],
  validate,
  adAccountController.getPageFeed
);

router.post(
  '/page/:pageId/posts',
  fetchUser,
  [param('pageId').isMongoId().withMessage('Invalid pageId')],
  validate,
  adAccountController.createPagePost
);

router.delete(
  '/page/:pageId/posts/:postId',
  fetchUser,
  [
    param('pageId').isMongoId().withMessage('Invalid pageId'),
    param('postId').isMongoId().withMessage('Invalid postId'),
  ],
  validate,
  adAccountController.deletePagePost
);

router.post('/account/create', fetchUser, adAccountController.createAccount);
router.get('/account/my',      fetchUser, adAccountController.getMyAccounts);
router.get('/account/:accountId', fetchUser, adAccountController.getAccount);
router.patch('/account/:accountId', fetchUser, adAccountController.updateAccount);
router.delete('/account/:accountId', fetchUser, adAccountController.deleteAccount);

// Pages under account
router.post('/account/:accountId/pages', fetchUser, adAccountController.createPage);
router.get('/account/:accountId/pages', fetchUser, adAccountController.listPages);
router.get('/account/:accountId/pages/:pageId', fetchUser, adAccountController.getPage);
router.patch('/account/:accountId/pages/:pageId', fetchUser, adAccountController.updatePage);
router.delete('/account/:accountId/pages/:pageId', fetchUser, adAccountController.deletePage);

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGN ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.post(
  '/campaign',
  fetchUser,
  [
    body('campaignName').isString().trim().notEmpty(),
    body('budget').isFloat({ min: 100 }),
    body('startDate').isISO8601(),
    body('endDate').isISO8601(),
    body('objective').optional().isIn(['traffic', 'engagement', 'awareness', 'leads', 'conversions']),
    body('bidPerClick').optional().isFloat({ min: 0.5 }),
  ],
  validate,
  ctrl.createCampaign
);

router.get('/my-campaigns', fetchUser, ctrl.getMyCampaigns);
router.get('/campaign/:id/analytics', fetchUser, ctrl.getCampaignAnalytics);

// ── FULL HIERARCHY (Campaign → AdSets → Ads) ──────────────────────────────────
router.get('/campaign/:campaignId/hierarchy', fetchUser, adSetCtrl.getCampaignHierarchy);

// ── AD SETS under a Campaign ──────────────────────────────────────────────────
router.get('/campaign/:campaignId/adsets', fetchUser, adSetCtrl.listAdSets);

// ═══════════════════════════════════════════════════════════════════════════
// AD SET ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.post(
  '/adset',
  fetchUser,
  [
    body('campaignId').isMongoId().withMessage('Valid campaignId required'),
    body('name').isString().trim().notEmpty(),
    body('startDate').isISO8601(),
    body('endDate').isISO8601(),
    body('placements').optional().isArray(),
    body('dailyBudgetCap').optional().isFloat({ min: 0 }),
  ],
  validate,
  adSetCtrl.createAdSet
);

router.get(
  '/adset/:adSetId',
  fetchUser,
  [param('adSetId').isMongoId()],
  validate,
  adSetCtrl.getAdSet
);

router.patch(
  '/adset/:adSetId',
  fetchUser,
  [param('adSetId').isMongoId()],
  validate,
  adSetCtrl.updateAdSet
);

router.delete(
  '/adset/:adSetId',
  fetchUser,
  [param('adSetId').isMongoId()],
  validate,
  adSetCtrl.deleteAdSet
);

// ═══════════════════════════════════════════════════════════════════════════
// AD (CREATIVE) ROUTES under AdSet
// ═══════════════════════════════════════════════════════════════════════════

router.post(
  '/adset/:adSetId/ad',
  fetchUser,
  [
    param('adSetId').isMongoId(),
    body('link').isURL({ protocols: ['https'] }).withMessage('link must be a valid HTTPS URL'),
    body('format').optional().isIn(['single_image', 'carousel', 'video', 'text_only']),
    body('mediaType').optional().isIn(['image', 'video', 'text']),
  ],
  validate,
  adSetCtrl.createAd
);

router.get(
  '/adset/:adSetId/ads',
  fetchUser,
  [param('adSetId').isMongoId()],
  validate,
  adSetCtrl.listAds
);

router.get(
  '/ad/:adId',
  fetchUser,
  [param('adId').isMongoId()],
  validate,
  adSetCtrl.getAd
);

router.patch(
  '/ad/:adId',
  fetchUser,
  [param('adId').isMongoId()],
  validate,
  adSetCtrl.updateAd
);

router.delete(
  '/ad/:adId',
  fetchUser,
  [param('adId').isMongoId()],
  validate,
  adSetCtrl.deleteAd
);

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY CREATIVE ROUTES (kept for backward compat)
// ═══════════════════════════════════════════════════════════════════════════

router.post(
  '/creative',
  fetchUser,
  [
    body('campaign_id').isMongoId(),
    body('link').isURL({ protocols: ['https'] }),
    body('mediaType').optional().isIn(['image', 'video', 'text']),
  ],
  validate,
  ctrl.addCreative
);

router.post(
  '/targeting',
  fetchUser,
  [body('campaign_id').isMongoId()],
  validate,
  ctrl.setTargeting
);

// ═══════════════════════════════════════════════════════════════════════════
// AD SERVING & TRACKING
// ═══════════════════════════════════════════════════════════════════════════

router.get('/feed', fetchUser, ctrl.getAdsForUser);

router.post(
  '/impression',
  [body('ad_id').isMongoId()],
  validate,
  ctrl.trackImpression
);

router.post(
  '/click',
  [body('ad_id').isMongoId()],
  validate,
  ctrl.trackClick
);

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/admin/all', fetchUser, verifyAdmin, ctrl.listAllCampaigns);

router.patch(
  '/admin/campaign/:id/status',
  fetchUser,
  verifyAdmin,
  [
    param('id').isMongoId(),
    body('status').isIn(['active', 'paused', 'rejected']),
    body('rejectionNote').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  ctrl.updateCampaignStatus
);

// Admin Ad Account management
router.get('/admin/accounts', fetchUser, verifyAdmin, adAccountController.adminListAccounts);
router.patch(
  '/admin/accounts/:accountId/status',
  fetchUser,
  verifyAdmin,
  [
    param('accountId').isMongoId(),
    body('status').isIn(['active', 'suspended', 'rejected']),
  ],
  validate,
  adAccountController.adminUpdateAccountStatus
);

module.exports = router;