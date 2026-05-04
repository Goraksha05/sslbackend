/**
 * controllers/userKycController.js
**/

'use strict';

const User             = require('../models/User');
const notifyUser       = require('../utils/notifyUser');
const compressFile     = require('../utils/compressFile');
const generateThumbnail = require('../utils/generateThumbnail');
const bus              = require('../intelligence/platformEventBus');
const { getIO }        = require('../sockets/socketManager');

const {
  extractText,
  extractAadhaar,
  extractPAN,
} = require('../services/kycOCRService');

const { verifyPAN } = require('../services/panVerificationService');

// Delegate to the canonical scoring service — no local reimplementation.
// This eliminates the formula drift that existed between the old inline copy
// (simple token ratio) and kycScoringService (Jaccard + rounding).
const {
  computeKycScore,
  getKycDecision,
} = require('../services/kycScoringService');

// ─────────────────────────────────────────────────────────────────────────────
// Notification configs
//
// Using type:'custom' universally because KYC-specific enum values
// ('kyc_submitted', etc.) may not exist in all Notification schema versions.
// Put the semantic label in the human-readable message instead. If you later
// add these values to the Notification schema enum, update the `type` fields
// here only — nothing else needs to change.
// ─────────────────────────────────────────────────────────────────────────────
const KYC_NOTIFY = {
  submitted: {
    message:     'Your KYC documents have been received and are under review.',
    type:        'custom',
    pushPayload: {
      title:   'KYC Submitted',
      message: "Your documents are under review. We'll notify you within 1–2 business days.",
      url:     '/profile?tab=kyc',
    },
  },
  auto_verified: {
    message:     'Your identity has been verified! You can now claim all rewards.',
    type:        'custom',
    pushPayload: {
      title:   'KYC Verified ✓',
      message: 'Congratulations! Your identity is verified. All rewards are now unlocked.',
      url:     '/profile?tab=kyc',
    },
  },
  rejected: {
    message:     'Your KYC was not approved. Please check the reason and resubmit.',
    type:        'custom',
    pushPayload: {
      title:   'KYC Rejected',
      message: 'Your KYC submission was not approved. Tap to see the reason and resubmit.',
      url:     '/profile?tab=kyc',
    },
  },
};

/**
 * Send a KYC lifecycle notification. Non-fatal — a notification failure must
 * never abort the main KYC flow.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {keyof KYC_NOTIFY} key
 */
async function kycNotify(userId, key) {
  const cfg = KYC_NOTIFY[key];
  if (!cfg) {
    console.warn(`[kycNotify] Unknown notification key: "${key}"`);
    return;
  }
  try {
    const result = await notifyUser(userId, cfg.message, cfg.type, {
      url:         cfg.pushPayload.url,
      pushPayload: cfg.pushPayload,
    });
    if (!result) {
      console.warn(
        `[kycNotify] notifyUser returned null for user ${userId} (key=${key}). ` +
        'DB write may have failed — check that the notification type is in the schema enum.'
      );
    }
  } catch (err) {
    console.error(`[kycNotify] Failed to notify user ${userId} (key=${key}):`, err.message);
  }
}

/**
 * Broadcast a KYC event to the admin dashboard room in real time.
 * Non-fatal — a socket failure must never abort an already-committed DB write.
 *
 * @param {'submitted'|'approved'|'rejected'} type
 * @param {{ kycId: string }} payload
 */
function emitKycRealtime(type, payload) {
  try {
    const io = getIO();
    if (!io) return;

    io.to('kyc_admins').emit('kyc:admin_update', { type, ...payload });
    io.to('kyc_admins').emit('kyc:stats_update',  { type });
  } catch (err) {
    console.warn('[userKycController] emitKycRealtime failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File processing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an absolute disk path returned by compressFile / multer into a
 * root-relative public URL served by the Express static middleware.
 *
 * Examples:
 *   "E:\app\uploads\kyc\file.jpg" → "/uploads/kyc/file.jpg"   (Windows)
 *   "/var/www/app/uploads/kyc/file.jpg" → "/uploads/kyc/file.jpg"  (Linux)
 *
 * If the path is already URL-shaped or does not contain "/uploads/", it is
 * returned unchanged so we never throw.
 *
 * @param {string|null} filePath
 * @returns {string|null}
 */
function diskPathToPublicUrl(filePath) {
  if (!filePath) return filePath;
  if (filePath.startsWith('/') || filePath.startsWith('http')) return filePath;

  const normalised = filePath.replace(/\\/g, '/');
  const idx = normalised.indexOf('/uploads/');

  if (idx !== -1) return normalised.slice(idx);

  // Last resort — serve by filename only (shouldn't normally reach here)
  return `/uploads/${require('path').basename(filePath)}`;
}

/**
 * Compress a multer file object and generate a thumbnail for it.
 *
 * Returns:
 *   diskPath   — absolute filesystem path (for OCR, liveness, face-match)
 *   url        — root-relative public URL (for DB storage + browser display)
 *   mimeType   — post-compression MIME type (may differ from original, e.g. PDF→JPEG)
 *   thumbnail  — root-relative public URL of the thumbnail (or null)
 *
 * Both compression and thumbnail generation are wrapped so a failure in
 * either step never throws — the KYC submission continues with whatever
 * outputs are available.
 *
 * @param {{ path: string, mimetype: string }} file  Multer file object
 * @returns {Promise<{ diskPath: string, url: string, mimeType: string, thumbnail: string|null }>}
 */
async function processFile(file) {
  // Step 1 — compress (resize, quality-reduce, PDF→JPEG when applicable)
  const compressed = await compressFile(file.path, file.mimetype);
  const diskPath   = compressed.filePath;
  const mimeType   = compressed.mimetype || file.mimetype;

  // Step 2 — thumbnail
  // Prefer any thumbnail already produced by compressFile (PDF previews, etc.).
  // Only call generateThumbnail when compressFile produced none.
  let thumbnailUrl = compressed.thumbnails?.[0]
    ? diskPathToPublicUrl(compressed.thumbnails[0])
    : null;

  if (!thumbnailUrl) {
    try {
      thumbnailUrl = await generateThumbnail(diskPath, mimeType);
    } catch (thumbErr) {
      // Non-fatal — KYC submission continues without a preview thumbnail.
      console.warn(
        `[processFile] generateThumbnail failed for ${diskPath}:`,
        thumbErr.message
      );
    }
  }

  return {
    diskPath,
    url:       diskPathToPublicUrl(diskPath),
    mimeType,
    thumbnail: thumbnailUrl || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/kyc/submit
// ─────────────────────────────────────────────────────────────────────────────
exports.submitKYC = async (req, res) => {
  try {
    const userId = req.user.id;
    const files  = req.files;

    // Defensive guard — kycUploadMiddleware should catch this first, but we
    // guard here too so the controller is safe if the middleware is bypassed.
    if (!files?.aadhaar || !files?.pan || !files?.bank || !files?.selfie) {
      return res.status(400).json({ message: 'All KYC documents are required.' });
    }

    // ── Step 1: Compress + thumbnail (parallel) ───────────────────────────────
    const [aadhaarFile, panFile, bankFile, selfieFile] = await Promise.all([
      processFile(files.aadhaar[0]),
      processFile(files.pan[0]),
      processFile(files.bank[0]),
      processFile(files.selfie[0]),
    ]);

    // ── Step 2: Load user ─────────────────────────────────────────────────────
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (user.kyc?.status === 'verified') {
      return res.status(400).json({ message: 'Your KYC is already verified.' });
    }

    // ── Step 3: OCR ───────────────────────────────────────────────────────────
    // Use diskPath (absolute filesystem path) — Tesseract reads from disk, not HTTP.
    const [aadhaarText, panText] = await Promise.all([
      extractText(aadhaarFile.diskPath),
      extractText(panFile.diskPath),
    ]);

    const aadhaarData = extractAadhaar(aadhaarText);
    const panData     = extractPAN(panText);

    // ── Step 4: PAN API verification ──────────────────────────────────────────
    const panVerification = panData?.panNumber
      ? await verifyPAN(panData.panNumber)
      : { valid: false, name: null };

    // ── Step 5: Liveness check (temporarily disabled) ─────────────────────────
    // const liveness = await checkLiveness(selfieFile.diskPath);
    const liveness = { live: true, reason: 'Liveness service not yet available' };

    // ── Step 6: Face match (temporarily disabled) ─────────────────────────────
    // const faceResult = await compareFaces(aadhaarFile.url, selfieFile.url);
    const faceResult = { match: false, score: null };

    // ── Step 7: Score + decision ──────────────────────────────────────────────
    const baseScore = computeKycScore({
      aadhaar:    aadhaarData,
      pan:        panData,
      panApiName: panVerification.name,
      userName:   user.name,
    });

    const finalScore = Math.min(
      baseScore + (faceResult.match ? 0.20 : 0),
      // + (liveness.live ? 0.10 : 0),  // re-enable when liveness service is live
      1.0
    );

    // NOTE: kycScoringService THRESHOLDS.MANUAL_REVIEW is set to 0.25 while
    // face-match and liveness services are disabled.  A score of 0.30 (valid
    // Aadhaar only) correctly routes to 'manual_review' → kycStatus='submitted'.
    // Raise MANUAL_REVIEW back to 0.55 in kycScoringService once both services
    // are re-enabled below.
    let decision = getKycDecision(finalScore);
    // Hard override: liveness failure always rejects regardless of score.
    // Re-enable this line when checkLiveness is live.
    // if (!liveness.live) decision = 'reject';

    if (process.env.NODE_ENV !== 'production') {
      console.log('KYC DEBUG:', {
        aadhaarData, panData,
        panApiName: panVerification.name,
        userName:   user.name,
        baseScore,  finalScore, decision,
      });
    }

    const kycStatus =
      decision === 'auto_approve'  ? 'verified'  :
      decision === 'manual_review' ? 'submitted' :
      'rejected';

    // ── Step 8: Persist KYC record ────────────────────────────────────────────
    // Assign the entire sub-document in a single operation to avoid the
    // "set fields then re-assign object" bug that wipes other sub-fields.
    user.kyc = {
      status: kycStatus,
      score:  finalScore,

      documents: {
        aadhaarFile:      aadhaarFile.url,
        panFile:          panFile.url,
        bankPassbookFile: bankFile.url,
        selfie:           selfieFile.url,
      },

      thumbnails: {
        aadhaarThumb: aadhaarFile.thumbnail || null,
        panThumb:     panFile.thumbnail     || null,
        bankThumb:    bankFile.thumbnail    || null,
        selfieThumb:  selfieFile.thumbnail  || null,
      },

      ocrData: {
        aadhaar: aadhaarData,
        pan:     panData,
      },

      // liveness and faceMatch are commented out pending service activation.
      // Uncomment and populate when services come online:
      // liveness:  { live: liveness.live, reason: liveness.reason || null },
      // faceMatch: { score: faceResult.score, matched: faceResult.match },

      submittedAt:     new Date(),
      verifiedAt:      kycStatus === 'verified' ? new Date() : null,
      rejectionReason: kycStatus === 'rejected'
        ? 'Document verification failed. Please check your details and resubmit.'
        : null,
    };

    // ── Step 9: Trust flags ───────────────────────────────────────────────────
    if (decision === 'auto_approve') {
      user.trustFlags.riskTier    = 'clean';
      user.trustFlags.kycRequired = false;
    } else if (decision === 'reject') {
      user.trustFlags.riskTier = 'watchlist';
    }

    await user.save();

    // ── Step 10: Notifications, event bus, socket (all non-fatal) ─────────────
    // These must never abort the flow — failures are logged but swallowed.
    await kycNotify(userId, 'submitted');

    bus.emit(bus.EVENTS.KYC_SUBMITTED, {
      userId:   String(userId),
      decision,
      score:    finalScore,
    });

    emitKycRealtime('submitted', { kycId: String(user._id) });

    if (decision === 'auto_approve') {
      await kycNotify(userId, 'auto_verified');

      bus.emit(bus.EVENTS.KYC_VERIFIED, { userId: String(userId) });

      emitKycRealtime('approved', { kycId: String(user._id) });
    }

    if (decision === 'reject') {
      await kycNotify(userId, 'rejected');

      bus.emit(bus.EVENTS.KYC_REJECTED, {
        userId: String(userId),
        reason: user.kyc.rejectionReason,
      });

      emitKycRealtime('rejected', { kycId: String(user._id) });
    }

    return res.json({
      message:  'KYC processed.',
      decision,
      score:    finalScore,
      status:   kycStatus,
    });

  } catch (err) {
    console.error('[submitKYC]', err);
    return res.status(500).json({ message: 'KYC processing failed. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/kyc/me
// Fetch the authenticated user's KYC status and details.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyKYC = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('kyc')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!user.kyc) {
      return res.status(404).json({ message: 'No KYC record found.' });
    }

    // Destructure to strip sensitive fields — only the remainder is sent.
    // eslint-disable-next-line no-unused-vars
    const { ocrData, thumbnails, verifiedBy, ...safeKyc } = user.kyc;

    return res.json(safeKyc);

  } catch (err) {
    console.error('[getMyKYC]', err);
    return res.status(500).json({ message: 'Failed to fetch KYC status.' });
  }
};