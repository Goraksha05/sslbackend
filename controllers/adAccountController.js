/**
 * controllers/adAccountController.js
 *
 * Handles Ad Account and Ad Page lifecycle:
 *
 * Ad Account routes:
 *   POST   /api/ads/account/create         — create a new ad account
 *   GET    /api/ads/account/my             — list caller's ad accounts
 *   GET    /api/ads/account/:accountId     — get single account detail
 *   PATCH  /api/ads/account/:accountId     — update account info
 *   DELETE /api/ads/account/:accountId     — soft-delete account
 *
 * Ad Page routes (nested under account):
 *   POST   /api/ads/account/:accountId/pages             — create a page
 *   GET    /api/ads/account/:accountId/pages             — list pages
 *   GET    /api/ads/account/:accountId/pages/:pageId     — get single page
 *   PATCH  /api/ads/account/:accountId/pages/:pageId     — update page
 *   DELETE /api/ads/account/:accountId/pages/:pageId     — delete page
 *
 * Admin routes:
 *   GET    /api/ads/admin/accounts                       — list all accounts
 *   PATCH  /api/ads/admin/accounts/:accountId/status     — approve/suspend/reject
 */

'use strict';

const mongoose   = require('mongoose');
const AdAccount  = require('../models/AdAccount');
const AdPage     = require('../models/AdPage');
const AdCampaign = require('../models/AdCampaign');
const User       = require('../models/User');
const notifyUser = require('../utils/notifyUser');
const { writeAudit } = require('../middleware/rbac');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/** Verify the account belongs to the calling user and is not deleted. */
async function loadOwnAccount(accountId, userId) {
  const account = await AdAccount.findOne({
    _id:       accountId,
    owner:     userId,
    isDeleted: false,
  });
  return account;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AD ACCOUNT — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ads/account/create
 * Body: { accountName, email?, industry?, billing? }
 *
 * The caller must be a registered SoShoLife user.
 * The email field defaults to the user's profile email.
 * The referralId is automatically pulled from the user record.
 */
exports.createAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { accountName, email, industry, billing } = req.body;

    if (!accountName?.trim()) {
      return res.status(400).json({
        message: 'accountName is required.',
        code:    'VALIDATION_ERROR',
      });
    }

    // Fetch the user to get email + referralId
    const user = await User.findById(userId).select('email referralId').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const resolvedEmail = (email || user.email || '').toLowerCase().trim();
    if (!resolvedEmail) {
      return res.status(400).json({
        message: 'An email address is required for the Ad Account.',
        code:    'EMAIL_REQUIRED',
      });
    }

    // Check account limit per user (max 5 active accounts)
    const existingCount = await AdAccount.countDocuments({
      owner:     userId,
      isDeleted: false,
    });
    if (existingCount >= 5) {
      return res.status(429).json({
        message: 'You have reached the maximum of 5 Ad Accounts.',
        code:    'ACCOUNT_LIMIT_REACHED',
      });
    }

    const account = await AdAccount.create({
      owner:      userId,
      accountName: accountName.trim(),
      email:      resolvedEmail,
      referralId: user.referralId || null,
      industry:   industry || 'other',
      billing:    billing || {},
      status:     'pending_review',
    });

    // Notify the user
    notifyUser(
      userId,
      `Your Ad Account "${account.accountName}" has been submitted for review. We'll notify you once it's approved.`,
      'custom',
      { url: '/ads/manager' }
    ).catch(() => {});

    return res.status(201).json({
      message: 'Ad Account created and submitted for review.',
      account: {
        _id:         account._id,
        accountId:   account.accountId,
        accountName: account.accountName,
        email:       account.email,
        status:      account.status,
        createdAt:   account.createdAt,
      },
    });
  } catch (err) {
    console.error('[createAccount]', err);
    return res.status(500).json({ message: 'Failed to create Ad Account.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/account/my
 * List all Ad Accounts owned by the calling user.
 */
exports.getMyAccounts = async (req, res) => {
  try {
    const accounts = await AdAccount.find({
      owner:     req.user.id,
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .lean();

    // Attach page count per account
    const accountIds = accounts.map(a => a._id);
    const pageCounts = await AdPage.aggregate([
      { $match: { adAccount: { $in: accountIds }, isDeleted: false } },
      { $group: { _id: '$adAccount', count: { $sum: 1 } } },
    ]);
    const pageCountMap = Object.fromEntries(
      pageCounts.map(p => [String(p._id), p.count])
    );

    const campaignCounts = await AdCampaign.aggregate([
      { $match: { adAccount: { $in: accountIds } } },
      { $group: { _id: '$adAccount', count: { $sum: 1 } } },
    ]);
    const campaignCountMap = Object.fromEntries(
      campaignCounts.map(c => [String(c._id), c.count])
    );

    const enriched = accounts.map(a => ({
      ...a,
      pageCount:    pageCountMap[String(a._id)]    || 0,
      campaignCount: campaignCountMap[String(a._id)] || 0,
    }));

    return res.json({ accounts: enriched });
  } catch (err) {
    console.error('[getMyAccounts]', err);
    return res.status(500).json({ message: 'Failed to fetch Ad Accounts.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/account/:accountId
 */
exports.getAccount = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const [pages, campaigns] = await Promise.all([
      AdPage.find({ adAccount: account._id, isDeleted: false }).lean(),
      AdCampaign.find({ adAccount: account._id }).select('campaignName status totalSpent createdAt').lean(),
    ]);

    return res.json({ account, pages, campaigns });
  } catch (err) {
    console.error('[getAccount]', err);
    return res.status(500).json({ message: 'Failed to fetch Ad Account.', code: 'SERVER_ERROR' });
  }
};

/**
 * PATCH /api/ads/account/:accountId
 * Update mutable fields — cannot change email or status.
 */
exports.updateAccount = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const { accountName, industry, billing } = req.body;
    if (accountName?.trim()) account.accountName = accountName.trim();
    if (industry)           account.industry    = industry;
    if (billing)            account.billing     = { ...account.billing.toObject?.() || account.billing, ...billing };

    await account.save();
    return res.json({ message: 'Ad Account updated.', account });
  } catch (err) {
    console.error('[updateAccount]', err);
    return res.status(500).json({ message: 'Failed to update Ad Account.', code: 'SERVER_ERROR' });
  }
};

/**
 * DELETE /api/ads/account/:accountId
 * Soft-delete. Active campaigns must be paused first.
 */
exports.deleteAccount = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const activeCampaigns = await AdCampaign.countDocuments({
      adAccount: account._id,
      status:    'active',
    });
    if (activeCampaigns > 0) {
      return res.status(409).json({
        message: `Cannot delete account — ${activeCampaigns} active campaign(s) must be paused first.`,
        code:    'ACTIVE_CAMPAIGNS_EXIST',
      });
    }

    account.isDeleted = true;
    account.deletedAt = new Date();
    await account.save();

    return res.json({ message: 'Ad Account deleted.' });
  } catch (err) {
    console.error('[deleteAccount]', err);
    return res.status(500).json({ message: 'Failed to delete Ad Account.', code: 'SERVER_ERROR' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// AD PAGE — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ads/account/:accountId/pages
 */
exports.createPage = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }
    if (account.status !== 'active') {
      return res.status(403).json({
        message: `Ad Account must be active to create Pages. Current status: ${account.status}.`,
        code:    'ACCOUNT_NOT_ACTIVE',
      });
    }

    const { pageName, tagline, about, category, website, contactEmail, contactPhone, logoUrl, coverUrl } = req.body;
    if (!pageName?.trim()) {
      return res.status(400).json({ message: 'pageName is required.', code: 'VALIDATION_ERROR' });
    }

    // Max 10 pages per account
    const pageCount = await AdPage.countDocuments({ adAccount: account._id, isDeleted: false });
    if (pageCount >= 10) {
      return res.status(429).json({
        message: 'Maximum of 10 Ad Pages per account.',
        code:    'PAGE_LIMIT_REACHED',
      });
    }

    const page = await AdPage.create({
      adAccount:    account._id,
      owner:        req.user.id,
      pageName:     pageName.trim(),
      tagline:      tagline || '',
      about:        about   || '',
      category:     category || account.industry || 'other',
      website:      website || null,
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      logoUrl:      logoUrl  || null,
      coverUrl:     coverUrl || null,
      status:       'active', // pages are active immediately (account already verified)
    });

    return res.status(201).json({ message: 'Ad Page created.', page });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Page name/slug already exists.', code: 'DUPLICATE' });
    }
    console.error('[createPage]', err);
    return res.status(500).json({ message: 'Failed to create Ad Page.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/account/:accountId/pages
 */
exports.listPages = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const pages = await AdPage.find({ adAccount: account._id, isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ pages });
  } catch (err) {
    console.error('[listPages]', err);
    return res.status(500).json({ message: 'Failed to fetch pages.', code: 'SERVER_ERROR' });
  }
};

/**
 * GET /api/ads/account/:accountId/pages/:pageId
 */
exports.getPage = async (req, res) => {
  try {
    const { accountId, pageId } = req.params;
    if (!isValidId(accountId) || !isValidId(pageId)) {
      return res.status(400).json({ message: 'Invalid ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const page = await AdPage.findOne({ _id: pageId, adAccount: account._id, isDeleted: false }).lean();
    if (!page) {
      return res.status(404).json({ message: 'Ad Page not found.', code: 'NOT_FOUND' });
    }

    // Campaigns that use this page
    const campaigns = await AdCampaign.find({ adPage: pageId })
      .select('campaignName status createdAt totalSpent impressionCount clickCount')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ page, campaigns });
  } catch (err) {
    console.error('[getPage]', err);
    return res.status(500).json({ message: 'Failed to fetch page.', code: 'SERVER_ERROR' });
  }
};

/**
 * PATCH /api/ads/account/:accountId/pages/:pageId
 */
exports.updatePage = async (req, res) => {
  try {
    const { accountId, pageId } = req.params;
    if (!isValidId(accountId) || !isValidId(pageId)) {
      return res.status(400).json({ message: 'Invalid ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const page = await AdPage.findOne({ _id: pageId, adAccount: account._id, isDeleted: false });
    if (!page) {
      return res.status(404).json({ message: 'Ad Page not found.', code: 'NOT_FOUND' });
    }

    const allowed = ['pageName', 'tagline', 'about', 'category', 'website',
                     'contactEmail', 'contactPhone', 'logoUrl', 'coverUrl'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) page[field] = req.body[field];
    }

    await page.save();
    return res.json({ message: 'Ad Page updated.', page });
  } catch (err) {
    console.error('[updatePage]', err);
    return res.status(500).json({ message: 'Failed to update page.', code: 'SERVER_ERROR' });
  }
};

/**
 * DELETE /api/ads/account/:accountId/pages/:pageId
 */
exports.deletePage = async (req, res) => {
  try {
    const { accountId, pageId } = req.params;
    if (!isValidId(accountId) || !isValidId(pageId)) {
      return res.status(400).json({ message: 'Invalid ID.', code: 'VALIDATION_ERROR' });
    }

    const account = await loadOwnAccount(accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const page = await AdPage.findOne({ _id: pageId, adAccount: account._id, isDeleted: false });
    if (!page) {
      return res.status(404).json({ message: 'Ad Page not found.', code: 'NOT_FOUND' });
    }

    const activeCampaigns = await AdCampaign.countDocuments({
      adPage: pageId,
      status: { $in: ['active', 'pending_review'] },
    });
    if (activeCampaigns > 0) {
      return res.status(409).json({
        message: `Cannot delete page — ${activeCampaigns} campaign(s) are currently using it.`,
        code:    'PAGE_IN_USE',
      });
    }

    page.isDeleted = true;
    await page.save();

    return res.json({ message: 'Ad Page deleted.' });
  } catch (err) {
    console.error('[deletePage]', err);
    return res.status(500).json({ message: 'Failed to delete page.', code: 'SERVER_ERROR' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Ad Account management
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/ads/admin/accounts
 * List all Ad Accounts (paginated, filterable).
 */
exports.adminListAccounts = async (req, res) => {
  try {
    const page   = Math.max(1,   parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 25);
    const skip   = (page - 1) * limit;

    const filter = { isDeleted: false };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search?.trim()) {
      const s = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { accountName: { $regex: s, $options: 'i' } },
        { email:       { $regex: s, $options: 'i' } },
        { accountId:   { $regex: s, $options: 'i' } },
      ];
    }

    const [accounts, total] = await Promise.all([
      AdAccount.find(filter)
        .populate('owner', 'name email username referralId')
        .populate('reviewedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdAccount.countDocuments(filter),
    ]);

    return res.json({
      accounts,
      pagination: { page, pages: Math.ceil(total / limit), total, limit },
    });
  } catch (err) {
    console.error('[adminListAccounts]', err);
    return res.status(500).json({ message: 'Failed to list accounts.', code: 'SERVER_ERROR' });
  }
};

/**
 * PATCH /api/ads/admin/accounts/:accountId/status
 * Body: { status: 'active'|'suspended'|'rejected', reviewNote? }
 */
exports.adminUpdateAccountStatus = async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!isValidId(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID.', code: 'VALIDATION_ERROR' });
    }

    const { status, reviewNote } = req.body;
    const VALID = ['active', 'suspended', 'rejected'];
    if (!VALID.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${VALID.join(', ')}`,
        code:    'VALIDATION_ERROR',
      });
    }

    const account = await AdAccount.findOne({ _id: accountId, isDeleted: false });
    if (!account) {
      return res.status(404).json({ message: 'Ad Account not found.', code: 'NOT_FOUND' });
    }

    const prevStatus = account.status;
    account.status     = status;
    account.reviewedBy = req.user.id;
    account.reviewedAt = new Date();
    account.reviewNote = reviewNote || null;
    await account.save();

    // Notify the owner
    const msg = status === 'active'
      ? `🎉 Your Ad Account "${account.accountName}" has been approved! You can now create Ads.`
      : status === 'rejected'
      ? `❌ Your Ad Account "${account.accountName}" was not approved. Reason: ${reviewNote || 'Please contact support.'}`
      : `⚠️ Your Ad Account "${account.accountName}" has been suspended. Please contact support.`;

    notifyUser(account.owner, msg, 'custom', { url: '/ads/manager' }).catch(() => {});

    await writeAudit(req, 'ad_account_status_change', {
      accountId:   String(account._id),
      accountName: account.accountName,
      prevStatus,
      newStatus:   status,
      reviewNote:  reviewNote || null,
    });

    return res.json({ message: `Ad Account status updated to ${status}.`, account });
  } catch (err) {
    console.error('[adminUpdateAccountStatus]', err);
    return res.status(500).json({ message: 'Failed to update account status.', code: 'SERVER_ERROR' });
  }
};

// ── GET /api/ads/page/:pageId/campaigns ──────────────────────────────────────
/**
 * Return all campaigns that reference a specific Ad Page.
 * Ownership is verified — the page must belong to the calling user.
 *
 * Response: { campaigns: AdCampaign[], total: number }
 */
exports.getPageCampaigns = async (req, res) => {
  try {
    const { pageId } = req.params;
    if (!isValidId(pageId)) {
      return res.status(400).json({ message: 'Invalid pageId.', code: 'VALIDATION_ERROR' });
    }

    // Verify ownership — the page must belong to this user
    const page = await AdPage.findOne({
      _id:       pageId,
      owner:     req.user.id,
      isDeleted: false,
    }).lean();

    if (!page) {
      return res.status(404).json({ message: 'Ad Page not found.', code: 'NOT_FOUND' });
    }

    const campaigns = await AdCampaign.find({ adPage: pageId })
      .populate('adAccount', 'accountName adsAccountId status')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ campaigns, total: campaigns.length });
  } catch (err) {
    console.error('[getPageCampaigns]', err);
    return res.status(500).json({ message: 'Failed to fetch page campaigns.', code: 'SERVER_ERROR' });
  }
};

// ── GET /api/ads/page/:pageId/feed ────────────────────────────────────────────
/**
 * Return the "post feed" for an Ad Page.
 *
 * Ad Pages don't have a standalone Post model yet — this endpoint returns an
 * empty array with a clear note so the frontend renders gracefully rather than
 * crashing on a 404. When a PagePost model is added in the future, replace the
 * stub body with the real query.
 *
 * Response: { posts: [], total: 0 }
 */
exports.getPageFeed = async (req, res) => {
  try {
    const { pageId } = req.params;
    if (!isValidId(pageId)) {
      return res.status(400).json({ message: 'Invalid pageId.', code: 'VALIDATION_ERROR' });
    }

    // Verify ownership
    const page = await AdPage.findOne({
      _id:       pageId,
      owner:     req.user.id,
      isDeleted: false,
    }).lean();

    if (!page) {
      return res.status(404).json({ message: 'Ad Page not found.', code: 'NOT_FOUND' });
    }

    // Page posts are not yet stored in a dedicated collection.
    // Return an empty feed so the UI renders without errors.
    return res.json({ posts: [], total: 0 });
  } catch (err) {
    console.error('[getPageFeed]', err);
    return res.status(500).json({ message: 'Failed to fetch page feed.', code: 'SERVER_ERROR' });
  }
};

// ── POST /api/ads/page/:pageId/posts ─────────────────────────────────────────
/**
 * Create a post on an Ad Page.
 *
 * Stub implementation — returns 501 with a clear message until a PagePost
 * model is created. This prevents the 404 and gives the frontend a meaningful
 * error if the feature is triggered.
 *
 * Response: { message, post }
 */
exports.createPagePost = async (req, res) => {
  try {
    const { pageId } = req.params;
    if (!isValidId(pageId)) {
      return res.status(400).json({ message: 'Invalid pageId.', code: 'VALIDATION_ERROR' });
    }

    const page = await AdPage.findOne({
      _id:       pageId,
      owner:     req.user.id,
      isDeleted: false,
    }).lean();

    if (!page) {
      return res.status(404).json({ message: 'Ad Page not found.', code: 'NOT_FOUND' });
    }

    // Page posts are not yet supported — return a clear stub response.
    return res.status(501).json({
      message: 'Page posts are not yet supported. This feature is coming soon.',
      code:    'NOT_IMPLEMENTED',
    });
  } catch (err) {
    console.error('[createPagePost]', err);
    return res.status(500).json({ message: 'Failed to create page post.', code: 'SERVER_ERROR' });
  }
};

// ── DELETE /api/ads/page/:pageId/posts/:postId ────────────────────────────────
/**
 * Delete a post from an Ad Page.
 * Stub until PagePost model exists.
 */
exports.deletePagePost = async (req, res) => {
  try {
    const { pageId, postId } = req.params;
    if (!isValidId(pageId) || !isValidId(postId)) {
      return res.status(400).json({ message: 'Invalid pageId or postId.', code: 'VALIDATION_ERROR' });
    }

    return res.status(501).json({
      message: 'Page posts are not yet supported.',
      code:    'NOT_IMPLEMENTED',
    });
  } catch (err) {
    console.error('[deletePagePost]', err);
    return res.status(500).json({ message: 'Failed to delete page post.', code: 'SERVER_ERROR' });
  }
};

// ── GET /api/ads/pages/my ─────────────────────────────────────────────────────
/**
 * Return ALL Ad Pages owned by the calling user, across every Ad Account.
 *
 * This flat endpoint is used by the Navbar AdsDashboard dropdown so it can
 * list pages without first knowing the account ID.
 *
 * Response: { pages: AdPage[], total: number }
 */
exports.getMyPages = async (req, res) => {
  try {
    // Find all non-deleted accounts owned by this user
    const accounts = await AdAccount.find({
      owner:     req.user.id,
      isDeleted: false,
    }).select('_id').lean();

    if (!accounts.length) {
      return res.json({ pages: [], total: 0 });
    }

    const accountIds = accounts.map(a => a._id);

    const pages = await AdPage.find({
      adAccount: { $in: accountIds },
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ pages, total: pages.length });
  } catch (err) {
    console.error('[getMyPages]', err);
    return res.status(500).json({ message: 'Failed to fetch your pages.', code: 'SERVER_ERROR' });
  }
};