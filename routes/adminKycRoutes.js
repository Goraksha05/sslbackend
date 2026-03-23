/**
 * routes/adminKycRoutes.js
 *
 * Changes in this version:
 *  1. Added POST /validate — pre-submission OCR cross-check.
 *     Called by the frontend Review step before the user hits "Submit KYC".
 *     Runs OCR on each document and returns field-match results so the user
 *     can fix mismatches immediately. Non-blocking: a validation failure does
 *     NOT prevent the final submit — it is advisory only.
 *
 *  2. The validate endpoint uses a separate multer instance (kycValidateUpload)
 *     that accepts only aadhaar, pan, and bank — not selfie, because selfie
 *     liveness is already handled client-side. Files are cleaned up by the
 *     controller after OCR regardless of result.
 *
 * Mount in index.js (unchanged):
 *   app.use('/api/kyc', require('./routes/adminKycRoutes'));
 */

'use strict';

const express   = require('express');
const router    = express.Router();
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');

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

const { validateKYC } = require('../controllers/kycValidateController');

// ── Multer for the validate endpoint ─────────────────────────────────────────
// Lighter than kycUpload: only aadhaar + pan + bank (no selfie), all optional.
// Files land in the same kyc uploads folder so compressFile / OCR paths work.
const KYC_UPLOAD_DIR = path.join(__dirname, '../uploads/kyc');
if (!fs.existsSync(KYC_UPLOAD_DIR)) fs.mkdirSync(KYC_UPLOAD_DIR, { recursive: true });

const validateStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, KYC_UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.user?.id || 'anon'}_validate_${file.fieldname}_${Date.now()}${ext}`);
  },
});

const ALLOWED_VALIDATE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const kycValidateUpload = multer({
  storage: validateStorage,
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_VALIDATE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`), false);
  },
}).fields([
  { name: 'aadhaar', maxCount: 1 },
  { name: 'pan',     maxCount: 1 },
  { name: 'bank',    maxCount: 1 },
  // selfie intentionally omitted — not OCR'd
]);

// ── User routes ───────────────────────────────────────────────────────────────

// POST /api/kyc/submit
// Full KYC submission with all 4 documents.
router.post('/submit', fetchuser, uploadKyc, submitKYC);

// POST /api/kyc/validate
// Pre-submission OCR cross-check. Returns field-match results for Aadhaar,
// PAN, and bank account. Advisory only — does not change KYC status.
router.post('/validate', fetchuser, kycValidateUpload, validateKYC);

// GET /api/kyc/me
// Returns the current user's KYC status (without raw OCR/document data).
router.get('/me', fetchuser, getMyKYC);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /api/kyc?status=submitted&search=foo&page=1&limit=30
router.get('/', fetchuser, isAdmin, getKYCUsers);

// GET /api/kyc/:id
router.get('/:id', fetchuser, isAdmin, getKYCDetail);

// PATCH /api/kyc/:id/approve
router.patch('/:id/approve', fetchuser, isAdmin, approveKYC);

// PATCH /api/kyc/:id/reject  — body: { reason: "..." }
router.patch('/:id/reject', fetchuser, isAdmin, rejectKYC);

module.exports = router;