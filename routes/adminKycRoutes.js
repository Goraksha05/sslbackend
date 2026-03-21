/**
 * routes/adminKycRoutes.js
 *
 * FIXES vs original:
 *  1. Added GET /:id route wired to new getKYCDetail controller
 *  2. Changed admin approve/reject from POST to PATCH (semantically correct)
 *  3. Added pagination query-param documentation comment
 *
 * Mount in index.js:
 *   app.use('/api/kyc', require('./routes/adminKycRoutes'));
 */

'use strict';

const express   = require('express');
const router    = express.Router();

const fetchuser = require('../middleware/fetchuser');
const isAdmin   = require('../middleware/isAdmin');
const uploadKyc = require('../middleware/kycUpload');

const {
  submitKYC,
  getKYCUsers,
  getKYCDetail,
  approveKYC,
  rejectKYC,
  getMyKYC,
} = require('../controllers/adminKycController');

// ── User routes ───────────────────────────────────────────────────────────────

// POST /api/kyc/submit
// Authenticated user submits KYC documents.
// kycUploadMiddleware validates and stores files before the controller runs.
router.post('/submit', fetchuser, uploadKyc, submitKYC);

// GET /api/kyc/me
// Returns the current user's KYC status (without raw OCR/document data).
router.get('/me', fetchuser, getMyKYC);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /api/kyc?status=submitted&search=foo&page=1&limit=30
// Paginated list of all KYC submissions.
router.get('/', fetchuser, isAdmin, getKYCUsers);

// GET /api/kyc/:id
// Full KYC record for a specific user (admin only).
router.get('/:id', fetchuser, isAdmin, getKYCDetail);

// PATCH /api/kyc/:id/approve
router.patch('/:id/approve', fetchuser, isAdmin, approveKYC);

// PATCH /api/kyc/:id/reject  — body: { reason: "..." }
router.patch('/:id/reject', fetchuser, isAdmin, rejectKYC);

module.exports = router;