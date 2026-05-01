/**
 * routes/kycRoutes.js
 *
 * User-facing KYC routes. Mount in your main Express app as:
 *
 *   const kycRoutes = require('./routes/kycRoutes');
 *   app.use('/api/kyc', kycRoutes);
 *
 * Endpoints registered here:
 *
 *   GET  /api/kyc/me          — fetch the current user's KYC status & safe fields
 *   POST /api/kyc/submit      — full KYC document submission (4 files)
 *   POST /api/kyc/validate    — pre-submission OCR validation (3 files, advisory)
 *
 * Auth: all routes require a valid JWT (fetchuser middleware).
 *
 * ── Root cause of the 404s ────────────────────────────────────────────────────
 * The controllers (adminKycController.submitKYC, adminKycController.getMyKYC,
 * kycValidateController.validateKYC) were fully implemented but never wired to
 * Express routes. This file is the missing link.
 *
 * KycContext.jsx calls:
 *   GET  /api/kyc/me        → exports.getMyKYC
 *   POST /api/kyc/submit    → exports.submitKYC
 *
 * KycVerification.jsx calls:
 *   POST /api/kyc/validate  → exports.validateKYC
 *   POST /api/kyc/submit    → exports.submitKYC   (same as above)
 */

'use strict';

const express = require('express');
const router  = express.Router();

// ── Auth middleware ────────────────────────────────────────────────────────────
// Adjust the path to wherever your JWT auth middleware lives.
// Common locations: '../middleware/fetchuser', '../middleware/auth',
// '../middleware/verifyToken', etc.
const fetchuser = require('../middleware/fetchuser');

// ── Upload middleware ─────────────────────────────────────────────────────────
const { kycUploadMiddleware, kycValidateUploadMiddleware } = require('../middleware/kycUpload');

// ── Controllers ───────────────────────────────────────────────────────────────
const { getMyKYC, submitKYC } = require('../controllers/userKycController');

const { validateKYC } = require('../controllers/kycValidateController');

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/kyc/me
 *
 * Returns the authenticated user's KYC sub-document (safe fields only —
 * ocrData, thumbnails, and verifiedBy are stripped server-side).
 *
 * Called by: KycContext.jsx → fetchKyc()
 *
 * Response 200: { status, documents, score, faceMatch, liveness,
 *                 submittedAt, verifiedAt, rejectionReason }
 * Response 404: { message: 'No KYC record found.' }   ← treated as NOT_STARTED
 *               by KycContext (sets status to 'not_started')
 */
router.get('/me', fetchuser, getMyKYC);

/**
 * POST /api/kyc/submit
 *
 * Full KYC submission. Accepts multipart/form-data with four file fields:
 *   aadhaar  — Aadhaar card front image
 *   pan      — PAN card image
 *   bank     — Bank passbook / statement first page
 *   selfie   — Live selfie
 *
 * Pipeline inside submitKYC:
 *   1. Compress files + generate thumbnails
 *   2. OCR (Tesseract) → extract Aadhaar & PAN numbers
 *   3. PAN API verification (name match)
 *   4. Liveness check (currently stubbed)
 *   5. Face match (currently stubbed)
 *   6. Score + decision (auto_approve | manual_review | reject)
 *   7. Persist to User.kyc sub-document
 *   8. Emit notifications + socket events
 *
 * Called by: KycContext.jsx → submitKyc()
 *            KycVerification.jsx → handleFinalSubmit() (XHR with progress)
 *
 * Response 200: { message, decision, score, status }
 * Response 400: missing files / already verified
 * Response 500: processing failure
 */
router.post(
  '/submit',
  fetchuser,
  kycUploadMiddleware,
  submitKYC
);

/**
 * POST /api/kyc/validate
 *
 * Lightweight pre-submission OCR validation called from the Review step
 * (Step 3 in KycVerification.jsx) BEFORE the user hits "Submit KYC".
 *
 * Processes aadhaar, pan, and bank files only (selfie liveness is handled
 * client-side). Returns advisory field-match results so the user can fix
 * mismatches immediately without wasting a full upload round-trip.
 *
 * Non-blocking: always returns 200 — failures set ok: false, never 4xx.
 * The final /submit is still allowed regardless of validate results.
 *
 * Called by: KycVerification.jsx → runPreSubmitValidation()
 *
 * Response 200: { aadhaar, pan, bank, allPassed }
 *   Each doc: { ok, numberExtracted, numberMatch, error, ... }
 */
router.post(
  '/validate',
  fetchuser,
  kycValidateUploadMiddleware,
  validateKYC
);

module.exports = router;