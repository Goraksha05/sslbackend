/* routes/kycRoutes.js */

'use strict';

const express = require('express');
const router  = express.Router();

// ── Auth middleware ────────────────────────────────────────────────────────────
const fetchuser = require('../middleware/fetchuser');

// ── Upload middleware ─────────────────────────────────────────────────────────
const { 
  kycUploadMiddleware, 
  kycValidateUploadMiddleware,
  cleanupFiles,
  validateMagicBytes,
} = require('../middleware/kycUpload');

// ── Controllers ───────────────────────────────────────────────────────────────
const { getMyKYC, submitKYC } = require('../controllers/userKycController');

const { validateKYC } = require('../controllers/kycValidateController');

// ── Routes ─────────────────────────────────────────────────────────────────────

/* GET /api/kyc/me */
router.get('/me', fetchuser, getMyKYC);

/* POST /api/kyc/submit */
router.post('/submit',
  fetchuser,
  kycUploadMiddleware,
  submitKYC
);

/* POST /api/kyc/validate */
router.post('/validate',
  fetchuser,
  kycValidateUploadMiddleware,
  validateKYC
);

module.exports = router;