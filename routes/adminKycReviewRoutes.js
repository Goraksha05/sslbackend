/**
 * routes/adminKycReviewRoutes.js
 *
 * Thin Express router that delegates to kycService and then broadcasts the
 * result to the kyc_admins socket room so admin panels stay in sync in
 * real time without polling.
 *
 * ── Mount point ───────────────────────────────────────────────────────────────
 *
 *   app.use('/api/admin/kyc-review', require('./routes/adminKycReviewRoutes'));
 *
 * ── Route table ───────────────────────────────────────────────────────────────
 *
 *   GET    /api/admin/kyc-review               getList          paginated list
 *   PATCH  /api/admin/kyc-review/:id/approve   approve          single approve
 *   PATCH  /api/admin/kyc-review/:id/reject    reject           single reject
 *   PATCH  /api/admin/kyc-review/bulk/approve  bulkApprove      batch approve
 *   PATCH  /api/admin/kyc-review/bulk/reject   bulkReject       batch reject
 *
 * ── Design notes ──────────────────────────────────────────────────────────────
 *
 *   Route ordering
 *   ──────────────
 *   The /bulk/:action routes are declared BEFORE /:id/:action because Express
 *   matches routes in registration order. If /:id/approve were registered first,
 *   "bulk" would be captured as the :id param and the wrong handler would run.
 *
 *   Error handling
 *   ──────────────
 *   Each handler wraps its service call in try/catch and forwards unexpected
 *   errors to next(err) so the application-level error middleware can log them
 *   uniformly. Validation errors (400) and not-found (404) are returned directly.
 *
 *   Socket broadcasts
 *   ─────────────────
 *   After every mutating action the route emits to the "kyc_admins" socket room:
 *     - kyc:admin_update  { kycId, type }       — single-record mutations
 *     - kyc:bulk_update   { ids, type }          — bulk mutations
 *     - kyc:stats_update  { type }               — stats delta per mutation
 *   These mirror the events already emitted by adminKycController so that
 *   AdminKycContext.js can handle both code paths with the same listeners.
 *
 *   The emitKycReview() helper is intentionally non-throwing: a socket failure
 *   must never abort an already-committed DB write.
 *
 *   Input validation
 *   ────────────────
 *   Bulk action bodies require a non-empty `ids` array. Bulk reject additionally
 *   requires a `reason` string. Invalid input returns 400 before the service
 *   call so kycService never receives malformed arguments.
 *
 *   Service contract (kycService)
 *   ──────────────────────────────
 *   getList(query)                → { records[], total, page, pages }
 *   approve(id, adminId)          → { record }   (throws on not-found / bad state)
 *   reject(id, adminId, reason)   → { record }
 *   bulkApprove(ids[], adminId)   → { count }
 *   bulkReject(ids[], adminId, reason) → { count }
 */

'use strict';

const express = require('express');

const router   = express.Router();
const fetchUser = require('../middleware/fetchuser');
const isAdmin   = require('../middleware/isAdmin');
const service   = require('../services/kycService');
const { getIO } = require('../sockets/socketManager');

// ─────────────────────────────────────────────────────────────────────────────
// Socket broadcast helper
//
// Emits to the kyc_admins room. Designed to be non-throwing so a socket
// failure never rolls back an already-committed DB write.
//
// @param {'approved'|'rejected'|'bulk_approved'|'bulk_rejected'} type
// @param {{ kycId?: string, ids?: string[] }} payload
// ─────────────────────────────────────────────────────────────────────────────
function emitKycReview(type, payload) {
  try {
    const io = getIO();
    if (!io) return;

    const isBulk = type.startsWith('bulk_');

    // Record-level event consumed by AdminKycContext kyc:admin_update listener
    // (single) or kyc:bulk_update listener (bulk).
    const recordEvent = isBulk ? 'kyc:bulk_update' : 'kyc:admin_update';
    io.to('kyc_admins').emit(recordEvent, { type, ...payload });

    // Stats delta — mirrors the shape emitted by adminKycController.
    // type mapping:
    //   approved      → 'approved'  (submitted--, verified++)
    //   rejected      → 'rejected'  (submitted--, rejected++)
    //   bulk_approved → 'approved'  (AdminKycContext handles the same delta)
    //   bulk_rejected → 'rejected'
    const statsType = type.replace('bulk_', '');
    io.to('kyc_admins').emit('kyc:stats_update', { type: statsType });

  } catch (err) {
    // Non-fatal — log and continue. The DB write has already been committed.
    console.warn('[adminKycReviewRoutes] socket emit failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware applied to all routes in this router
// ─────────────────────────────────────────────────────────────────────────────
router.use(fetchUser, isAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/kyc-review
//
// Paginated list of KYC records, proxied from kycService.getList().
// Query params forwarded verbatim: status, search, page, limit.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const result = await service.getList(req.query);
    return res.json(result);
  } catch (err) {
    console.error('[adminKycReviewRoutes] getList error:', err.message);
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  IMPORTANT — Route ordering
//
// /bulk/approve and /bulk/reject MUST be declared before /:id/approve and
// /:id/reject. Express matches in registration order; registering /:id first
// would capture the literal string "bulk" as the :id param.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/kyc-review/bulk/approve
//
// Body: { ids: string[] }
// Batch-approves a list of KYC records. Returns the count of records updated.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/bulk/approve', async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message:   'ids must be a non-empty array of record IDs.',
        errorCode: 'INVALID_IDS',
      });
    }

    const result = await service.bulkApprove(ids, req.user.id);

    emitKycReview('bulk_approved', { ids });

    return res.json({
      message: `${result?.count ?? ids.length} records approved.`,
      ids,
    });
  } catch (err) {
    console.error('[adminKycReviewRoutes] bulkApprove error:', err.message);
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/kyc-review/bulk/reject
//
// Body: { ids: string[], reason: string }
// Batch-rejects a list of KYC records with a mandatory reason.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/bulk/reject', async (req, res, next) => {
  try {
    const { ids, reason } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message:   'ids must be a non-empty array of record IDs.',
        errorCode: 'INVALID_IDS',
      });
    }

    if (!reason?.trim()) {
      return res.status(400).json({
        message:   'A rejection reason is required.',
        errorCode: 'REASON_REQUIRED',
      });
    }

    const result = await service.bulkReject(ids, req.user.id, reason.trim());

    emitKycReview('bulk_rejected', { ids });

    return res.json({
      message: `${result?.count ?? ids.length} records rejected.`,
      ids,
    });
  } catch (err) {
    console.error('[adminKycReviewRoutes] bulkReject error:', err.message);
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/kyc-review/:id/approve
//
// Approves a single KYC record.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/approve', async (req, res, next) => {
  try {
    const result = await service.approve(req.params.id, req.user.id);

    emitKycReview('approved', { kycId: req.params.id });

    return res.json(result);
  } catch (err) {
    // Surface service-layer validation errors (e.g. "already verified") as 400.
    if (err.status === 400 || err.statusCode === 400) {
      return res.status(400).json({ message: err.message });
    }
    if (err.status === 404 || err.statusCode === 404) {
      return res.status(404).json({ message: err.message });
    }
    console.error('[adminKycReviewRoutes] approve error:', err.message);
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/kyc-review/:id/reject
//
// Body: { reason: string }
// Rejects a single KYC record with a mandatory reason.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;

    if (!reason?.trim()) {
      return res.status(400).json({
        message:   'A rejection reason is required.',
        errorCode: 'REASON_REQUIRED',
      });
    }

    const result = await service.reject(req.params.id, req.user.id, reason.trim());

    emitKycReview('rejected', { kycId: req.params.id });

    return res.json(result);
  } catch (err) {
    if (err.status === 400 || err.statusCode === 400) {
      return res.status(400).json({ message: err.message });
    }
    if (err.status === 404 || err.statusCode === 404) {
      return res.status(404).json({ message: err.message });
    }
    console.error('[adminKycReviewRoutes] reject error:', err.message);
    return next(err);
  }
});

module.exports = router;