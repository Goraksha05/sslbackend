/**
 * controllers/adminKycController.js
 *
 * Enhancements over previous version:
 *
 *  notifyUser integration
 *    - All calls now pass the correct (userId, message, type, opts) signature.
 *      Previously the type string was being passed as the message arg, meaning
 *      the DB record stored "kyc_submitted" as the human text and the type
 *      field defaulted to "custom" — the notification bell showed raw keys.
 *    - Every call now includes opts.pushPayload so web-push delivers a
 *      readable title + body instead of an empty notification.
 *    - opts.url is set on each notification so deep-linking works.
 *    - notifyUser return value is checked; a null return (DB failure) is
 *      logged as a warning but does not abort the KYC flow.
 *
 *  generateThumbnail integration
 *    - processFile now calls generateThumbnail as a reliable fallback when
 *      compressFile returns no thumbnail (e.g. plain image uploads where the
 *      video/PDF thumbnail path in compressFile is never reached).
 *    - generateThumbnail failures are caught per-file and logged — they never
 *      block the submission.
 *    - Thumbnail paths are stored alongside document URLs so the admin panel
 *      can render previews without re-processing files.
 *
 *  compressFile integration
 *    - processFile now surfaces the post-compression mimetype returned by
 *      compressFile. This matters when a DOCX is converted to PDF inside
 *      compressFile — the stored mimetype would otherwise still say "docx".
 *    - The returned mimetype is forwarded to generateThumbnail so it can
 *      choose the correct rendering path (image vs PDF).
 *
 *  General
 *    - notifyMany imported (available for future bulk-notification use).
 *    - All admin action handlers (approve/reject/reset) now send structured
 *      push payloads with titles and deep-link URLs.
 *    - rejectKYC now clears verifiedAt and verifiedBy when re-rejecting a
 *      previously approved record (edge case: admin reversal).
 *    - getKYCUsers now includes thumbnail URLs in the response so list views
 *      can show document previews without a second fetch.
 *    - Added exports.resetKYC — lets an admin wipe a KYC record entirely
 *      so the user can resubmit from scratch (useful for corrupted uploads).
 *    - Added exports.getKYCStats — aggregate counts per status for the
 *      admin dashboard header cards.
 */

'use strict';

const User                        = require('../models/User');
const notifyUser                  = require('../utils/notifyUser');
const { notifyMany }              = require('../utils/notifyUser');
const compressFile                = require('../utils/compressFile');
const generateThumbnail           = require('../utils/generateThumbnail');
const { checkLiveness }           = require('../services/livenessService');
const bus                         = require('../intelligence/platformEventBus');

const {
  extractText,
  extractAadhaar,
  extractPAN,
} = require('../services/kycOCRService');

const { verifyPAN } = require('../services/panVerificationService');

// ─────────────────────────────────────────────────────────────────────────────
// Notification messages & push payloads
// Centralised here so every call site stays consistent and translatable later.
// ─────────────────────────────────────────────────────────────────────────────
// ── Notification type safety ───────────────────────────────────────────────────
// The Notification model's `type` enum only contains values explicitly defined
// in its schema. KYC-specific type strings like 'kyc_submitted' / 'kyc_rejected'
// are NOT guaranteed to be in that enum unless you add them.
// Using an unlisted value causes a Mongoose ValidationError and notifyUser()
// returns null (DB write fails silently).
//
// Strategy: always pass 'custom' as the DB type (universally accepted) and put
// the semantic label in the human-readable message. The push notification title
// carries the full context to the user's device regardless.
//
// If you later add 'kyc_submitted' etc. to the Notification schema enum, simply
// change the `type` values below — no other code needs to change.
// ─────────────────────────────────────────────────────────────────────────────
const KYC_NOTIFY = {
  submitted: {
    message:     'Your KYC documents have been received and are under review.',
    type:        'custom',          // safe for all Notification schema versions
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
  admin_verified: {
    message:     'Your KYC has been reviewed and approved by our team.',
    type:        'custom',
    pushPayload: {
      title:   'KYC Approved ✓',
      message: 'Great news! Our team has verified your identity. You can now claim all rewards.',
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
  reset: {
    message:     'Your KYC record has been reset. Please resubmit your documents.',
    type:        'custom',
    pushPayload: {
      title:   'KYC Reset',
      message: 'Your KYC record was cleared by our team. Please resubmit your documents.',
      url:     '/profile?tab=kyc',
    },
  },
};

/**
 * Fire a notifyUser call with the pre-built config above.
 * Logs a warning if the DB write fails (returns null) but never throws —
 * notification failure must never abort the main KYC flow.
 *
 * @param {string|ObjectId} userId
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
      console.warn(`[kycNotify] notifyUser returned null for user ${userId} (key=${key}). DB write may have failed.`);
    }
  } catch (err) {
    // Notification errors are non-fatal — log and continue
    console.error(`[kycNotify] Failed to notify user ${userId} (key=${key}):`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KYC scoring helpers
// ─────────────────────────────────────────────────────────────────────────────
function nameMatchScore(ocrName, userName) {
  if (!ocrName || !userName) return 0;
  const ocrTokens  = ocrName.toLowerCase().split(/\s+/);
  const userTokens = userName.toLowerCase().split(/\s+/);
  const matches    = ocrTokens.filter(t => userTokens.includes(t)).length;
  return matches / Math.max(ocrTokens.length, userTokens.length);
}

function computeKycScore({ aadhaar, pan, panApiName, userName }) {
  let score = 0;
  if (aadhaar?.aadhaarNumber)                    score += 0.30;
  if (pan?.panNumber)                            score += 0.20;
  score += nameMatchScore(panApiName,      userName) * 0.25;
  score += nameMatchScore(aadhaar?.name,   userName) * 0.25;
  return Math.min(score, 1.0);
}

function getKycDecision(finalScore) {
  if (finalScore >= 0.85) return 'auto_approve';
  if (finalScore >= 0.55) return 'manual_review';
  return 'reject';
}

// ─────────────────────────────────────────────────────────────────────────────
// processFile
//
// 1. Compresses the file via compressFile (resize, quality-reduce, PDF→JPEG).
//    compressFile has its own try/catch and always returns a usable filePath,
//    so we never 500 on compression failure.
//
// 2. Generates a thumbnail via generateThumbnail.
//    - Uses the post-compression mimetype returned by compressFile (important
//      for DOCX→PDF conversions where the extension changes inside compressFile).
//    - Falls back gracefully: thumbnail failure is logged but never throws.
//    - If compressFile already produced a thumbnail (video, PDF), we prefer
//      that over calling generateThumbnail again to avoid double processing.
// ─────────────────────────────────────────────────────────────────────────────
// ─── Path → public URL helper ──────────────────────────────────────────────
// Converts an absolute disk path returned by compressFile / multer into a
// root-relative URL that the Express static middleware serves under /uploads/.
//
// Example (Windows):
//   "E:\sslapp\sslbackend\uploads\kyc\69bb_aadhaar_123.jpg"
//   → "/uploads/kyc/69bb_aadhaar_123.jpg"
//
// Example (Linux):
//   "/var/www/app/uploads/kyc/69bb_aadhaar_123.jpg"
//   → "/uploads/kyc/69bb_aadhaar_123.jpg"
//
// If the path doesn't contain "/uploads/" (shouldn't happen but be safe),
// returns the input unchanged so we never crash.
function diskPathToPublicUrl(filePath) {
  if (!filePath) return filePath;
  // Already a URL (e.g. from generateThumbnail after the fix)
  if (filePath.startsWith('/') || filePath.startsWith('http')) return filePath;
  // Normalise Windows backslashes
  const normalised = filePath.replace(/\\/g, '/');
  const idx = normalised.indexOf('/uploads/');
  if (idx !== -1) return normalised.slice(idx);
  // Last resort — serve by filename only
  const { path: nodePath } = require('path');
  return `/uploads/${require('path').basename(filePath)}`;
}

async function processFile(file) {
  // Step 1 — compress
  const compressed = await compressFile(file.path, file.mimetype);
  // compressed = { filePath, mimetype, thumbnails: string[] }

  const filePath    = compressed.filePath;
  const mimeType    = compressed.mimetype || file.mimetype;

  // Step 2 — thumbnail
  // Prefer any thumbnail already produced by compressFile (video frames, PDF
  // previews). Only call generateThumbnail when compressFile produced none.
  //
  // FIX: compressFile.thumbnails[0] is an absolute disk path — convert it.
  // generateThumbnail (after the companion fix) already returns a public URL.
  let thumbnailUrl = compressed.thumbnails?.[0]
    ? diskPathToPublicUrl(compressed.thumbnails[0])
    : null;

  if (!thumbnailUrl) {
    try {
      // generateThumbnail handles image/* and application/pdf; returns null
      // for unsupported types — that's fine, we just store null.
      // After the fix in generateThumbnail.js it returns a public URL directly.
      thumbnailUrl = await generateThumbnail(filePath, mimeType);
    } catch (thumbErr) {
      // Non-fatal — KYC submission continues without a preview thumbnail
      console.warn(
        `[processFile] generateThumbnail failed for ${filePath}:`,
        thumbErr.message
      );
    }
  }

  return {
    // FIX: store a public URL ("/uploads/kyc/..."), not the absolute disk path.
    // The browser needs an HTTP URL, not a file:// path.
    url:       diskPathToPublicUrl(filePath),
    mimeType,
    thumbnail: thumbnailUrl || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 📌 USER: Submit KYC
// ─────────────────────────────────────────────────────────────────────────────
exports.submitKYC = async (req, res) => {
  try {
    const userId = req.user.id;
    const files  = req.files;

    // Defensive guard — kycUploadMiddleware should catch this first
    if (!files?.aadhaar || !files?.pan || !files?.bank || !files?.selfie) {
      return res.status(400).json({ message: 'All KYC documents are required.' });
    }

    // ── Step 1: Compress all files + generate thumbnails in parallel ──────────
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
    // Only run OCR on the document files (not bank passbook or selfie)
    const [aadhaarText, panText] = await Promise.all([
      extractText(aadhaarFile.url),
      extractText(panFile.url),
    ]);

    const aadhaarData = extractAadhaar(aadhaarText);
    const panData     = extractPAN(panText);

    // ── Step 4: PAN API verification ──────────────────────────────────────────
    const panVerification = panData?.panNumber
      ? await verifyPAN(panData.panNumber)
      : { valid: false, name: null };

    // ── Step 5: Liveness check ────────────────────────────────────────────────
    const liveness = await checkLiveness(selfieFile.url);

    // ── Step 6: Face match (disabled until service is live) ───────────────────
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
      baseScore
        + (faceResult.match ? 0.20 : 0)
        + (liveness.live    ? 0.10 : 0),
      1.0
    );

    // Hard override: liveness failure always rejects regardless of score
    let decision = getKycDecision(finalScore);
    if (!liveness.live) decision = 'reject';

    const kycStatus =
      decision === 'auto_approve'  ? 'verified'  :
      decision === 'manual_review' ? 'submitted' :
      'rejected';

    // ── Step 8: Persist KYC record ────────────────────────────────────────────
    // Single assignment — avoids the "set fields then re-assign object" bug
    // that wiped sub-fields in the original version.
    user.kyc = {
      status: kycStatus,
      score:  finalScore,

      documents: {
        aadhaarFile:      aadhaarFile.url,
        panFile:          panFile.url,
        bankPassbookFile: bankFile.url,
        selfie:           selfieFile.url,
      },

      // Thumbnail paths stored for admin panel previews
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

      liveness: {
        live:   liveness.live,
        reason: liveness.reason || null,
      },

      // faceMatch: { score: faceResult.score, matched: faceResult.match },

      submittedAt:     new Date(),
      verifiedAt:      kycStatus === 'verified' ? new Date() : null,
      rejectionReason: kycStatus === 'rejected'
        ? 'Liveness check failed. Please retake your selfie in good lighting.'
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

    // ── Step 10: Notifications + event bus ───────────────────────────────────
    // Notifications and bus events are non-fatal — failures must never abort
    // the KYC flow or cause a 500. bus.emit can throw when platformEventBus
    // tries to persist to a model that doesn't exist yet (missing migration).
    await kycNotify(userId, 'submitted');

    try {
      bus.emit(bus.EVENTS.KYC_SUBMITTED, {
        userId:   String(userId),
        decision,
        score:    finalScore,
      });
    } catch (busErr) {
      console.warn('[submitKYC] bus.emit KYC_SUBMITTED failed:', busErr.message);
    }

    // Auto-approved: send verified notification immediately
    if (decision === 'auto_approve') {
      await kycNotify(userId, 'auto_verified');
      try {
        bus.emit(bus.EVENTS.KYC_VERIFIED, { userId: String(userId) });
      } catch (busErr) {
        console.warn('[submitKYC] bus.emit KYC_VERIFIED failed:', busErr.message);
      }
    }

    // Auto-rejected: send rejection notification
    if (decision === 'reject') {
      await kycNotify(userId, 'rejected');
      try {
        bus.emit(bus.EVENTS.KYC_REJECTED, {
          userId: String(userId),
          reason: user.kyc.rejectionReason,
        });
      } catch (busErr) {
        console.warn('[submitKYC] bus.emit KYC_REJECTED failed:', busErr.message);
      }
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
// 📌 ADMIN: List KYC submissions
// ─────────────────────────────────────────────────────────────────────────────
exports.getKYCUsers = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 30 } = req.query;

    const query = {};

    // Status filter — validate against known values to prevent injection
    const VALID_STATUSES = ['not_started', 'required', 'submitted', 'verified', 'rejected'];
    if (status && VALID_STATUSES.includes(status)) {
      query['kyc.status'] = status;
    }

    if (search?.trim()) {
      query.$or = [
        { email:    { $regex: search.trim(), $options: 'i' } },
        { username: { $regex: search.trim(), $options: 'i' } },
        { name:     { $regex: search.trim(), $options: 'i' } },
      ];
    }

    const pageNum  = Math.max(1, parseInt(page,  10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip     = (pageNum - 1) * limitNum;

    const [users, total] = await Promise.all([
      User.find(query)
        // Include thumbnail paths so the admin list view can show previews
        .select('name email username kyc.status kyc.score kyc.submittedAt kyc.verifiedAt kyc.liveness kyc.thumbnails trustFlags')
        .sort({ 'kyc.submittedAt': -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(query),
    ]);

    return res.json({
      users,
      total,
      page:  pageNum,
      pages: Math.ceil(total / limitNum),
    });

  } catch (err) {
    console.error('[getKYCUsers]', err);
    return res.status(500).json({ message: 'Failed to fetch KYC users.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 📌 ADMIN: Get single KYC record (full detail)
// ─────────────────────────────────────────────────────────────────────────────
exports.getKYCDetail = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('name email username kyc trustFlags')
      .lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    return res.json(user);
  } catch (err) {
    console.error('[getKYCDetail]', err);
    return res.status(500).json({ message: 'Failed to fetch KYC record.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 📌 ADMIN: Approve KYC
// ─────────────────────────────────────────────────────────────────────────────
exports.approveKYC = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (user.kyc?.status === 'verified') {
      return res.status(400).json({ message: 'KYC is already verified.' });
    }

    // Guard: can only approve a submitted record
    if (!['submitted', 'rejected'].includes(user.kyc?.status)) {
      return res.status(400).json({
        message: `Cannot approve KYC with status "${user.kyc?.status || 'not_started'}". Only submitted or rejected records can be approved.`,
      });
    }

    user.kyc.status          = 'verified';
    user.kyc.verifiedAt      = new Date();
    user.kyc.verifiedBy      = req.user.id;
    user.kyc.rejectionReason = null;

    user.trustFlags.riskTier    = 'clean';
    user.trustFlags.riskScore   = 0;
    user.trustFlags.kycRequired = false;

    await user.save();

    await kycNotify(user._id, 'admin_verified');

    try {
      bus.emit(bus.EVENTS.KYC_VERIFIED, {
        userId:     String(user._id),
        approvedBy: String(req.user.id),
      });
    } catch (busErr) {
      console.warn('[approveKYC] bus.emit KYC_VERIFIED failed:', busErr.message);
    }

    return res.json({ message: 'KYC approved.' });

  } catch (err) {
    console.error('[approveKYC]', err);
    return res.status(500).json({ message: 'Approval failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 📌 ADMIN: Reject KYC
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectKYC = async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason?.trim()) {
      return res.status(400).json({ message: 'A rejection reason is required.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (user.kyc?.status === 'rejected') {
      return res.status(400).json({ message: 'KYC is already rejected.' });
    }

    user.kyc.status          = 'rejected';
    user.kyc.rejectionReason = reason.trim();

    // Clear verification fields if this is a reversal of a previous approval
    if (user.kyc.verifiedAt) {
      user.kyc.verifiedAt  = null;
      user.kyc.verifiedBy  = null;
    }

    user.trustFlags.riskTier = 'watchlist';

    await user.save();

    // Notify with the admin-supplied reason embedded in the push body
    const notifyOpts = {
      url:         KYC_NOTIFY.rejected.pushPayload.url,
      pushPayload: {
        ...KYC_NOTIFY.rejected.pushPayload,
        // Surface the specific rejection reason in the notification body
        message: `Your KYC was not approved: ${reason.trim()}`,
      },
    };

    try {
      const result = await notifyUser(
        user._id,
        `Your KYC was not approved: ${reason.trim()}`,
        'custom',   // 'kyc_rejected' is not in the Notification schema enum
        notifyOpts
      );
      if (!result) {
        console.warn(`[rejectKYC] notifyUser returned null for user ${user._id}`);
      }
    } catch (notifyErr) {
      console.error('[rejectKYC] Notification failed:', notifyErr.message);
    }

    try {
      bus.emit(bus.EVENTS.KYC_REJECTED, {
        userId:     String(user._id),
        rejectedBy: String(req.user.id),
        reason:     reason.trim(),
      });
    } catch (busErr) {
      console.warn('[rejectKYC] bus.emit KYC_REJECTED failed:', busErr.message);
    }

    return res.json({ message: 'KYC rejected.' });

  } catch (err) {
    console.error('[rejectKYC]', err);
    return res.status(500).json({ message: 'Rejection failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 📌 ADMIN: Reset KYC
//
// Wipes the user's KYC record entirely so they can resubmit from scratch.
// Useful when documents are corrupted, uploaded in the wrong slots, or the
// user name has legally changed.
// ─────────────────────────────────────────────────────────────────────────────
exports.resetKYC = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!user.kyc || user.kyc.status === 'not_started') {
      return res.status(400).json({ message: 'No KYC record to reset.' });
    }

    // Preserve the submission history as a comment in the audit log if needed,
    // but wipe everything back to the initial state.
    user.kyc = {
      status:          'not_started',
      documents:       {},
      thumbnails:      {},
      ocrData:         {},
      liveness:        {},
      score:           0,
      verifiedAt:      null,
      verifiedBy:      null,
      rejectionReason: null,
      submittedAt:     null,
    };

    user.trustFlags.kycRequired = true;

    await user.save();

    await kycNotify(user._id, 'reset');

    try {
      bus.emit(bus.EVENTS.KYC_RESET ?? 'kyc_reset', {
        userId:  String(user._id),
        resetBy: String(req.user.id),
      });
    } catch (busErr) {
      console.warn('[resetKYC] bus.emit KYC_RESET failed:', busErr.message);
    }

    return res.json({ message: 'KYC record reset. User can now resubmit.' });

  } catch (err) {
    console.error('[resetKYC]', err);
    return res.status(500).json({ message: 'Reset failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 📌 ADMIN: KYC Statistics
//
// Returns counts per status — used by the admin dashboard header cards.
// Single aggregation pipeline, no per-status queries.
// ─────────────────────────────────────────────────────────────────────────────
exports.getKYCStats = async (req, res) => {
  try {
    const results = await User.aggregate([
      {
        $group: {
          _id:   '$kyc.status',
          count: { $sum: 1 },
        },
      },
    ]);

    // Normalise into a flat object with guaranteed keys
    const defaults = {
      not_started: 0,
      required:    0,
      submitted:   0,
      verified:    0,
      rejected:    0,
      null:        0, // users with no kyc sub-document at all
    };

    const stats = results.reduce((acc, row) => {
      const key = row._id ?? 'null';
      acc[key]  = row.count;
      return acc;
    }, defaults);

    // Pending = submitted (awaiting admin review)
    stats.pending = stats.submitted;

    return res.json(stats);

  } catch (err) {
    console.error('[getKYCStats]', err);
    return res.status(500).json({ message: 'Failed to fetch KYC stats.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 📌 USER: Get my KYC status
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

    // Strip sensitive fields from user-facing response:
    //   ocrData — contains raw Aadhaar/PAN numbers
    //   thumbnails — internal file paths, not needed by the frontend
    //   verifiedBy — internal admin ID
    const {
      ocrData,
      thumbnails,
      verifiedBy,
      ...safeKyc
    } = user.kyc;

    return res.json(safeKyc);

  } catch (err) {
    console.error('[getMyKYC]', err);
    return res.status(500).json({ message: 'Failed to fetch KYC status.' });
  }
};