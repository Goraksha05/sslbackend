/**
 * controllers/adminKycController.js
**/

'use strict';
const { getIO }                   = require('../sockets/socketManager');
const User                        = require('../models/User');
const Notification                = require('../models/Notification');
const notifyUser                  = require('../utils/notifyUser');
const { notifyMany }              = require('../utils/notifyUser');
const compressFile                = require('../utils/compressFile');
const generateThumbnail           = require('../utils/generateThumbnail');
const { creditReferralReward }    = require('./specialOfferController');
// const { checkLiveness }           = require('../services/livenessService');    //------------------ Temporarily disabled until the service is live
// const { compareFaces }            = require('../services/faceMatchService');  //------------------ Temporarily disabled until the service is live
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

// ─────────────────────────────────────────────
// REALTIME EMITTER (CLEAN)
// ─────────────────────────────────────────────
function emitKycRealtime(type, payload) {
  try {
    const io = getIO();
    if (!io) return;

    io.to("kyc_admins").emit("kyc:admin_update", {
      type,
      ...payload,
    });

    io.to("kyc_admins").emit("kyc:stats_update", {
      type,
    });

  } catch (err) {
    console.warn("[Realtime Emit Failed]:", err.message);
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

  // diskPath is the absolute filesystem path — needed for OCR, liveness, etc.
  const diskPath = compressed.filePath;
  const mimeType = compressed.mimetype || file.mimetype;

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
      thumbnailUrl = await generateThumbnail(diskPath, mimeType);
    } catch (thumbErr) {
      // Non-fatal — KYC submission continues without a preview thumbnail
      console.warn(
        `[processFile] generateThumbnail failed for ${diskPath}:`,
        thumbErr.message
      );
    }
  }

  return {
    // diskPath: absolute filesystem path — used by OCR, liveness, face-match.
    // DO NOT use this for storing in DB or sending to browser.
    diskPath,
    // url: root-relative public URL served by Express static middleware.
    // Use this for DB storage and browser display.
    url:       diskPathToPublicUrl(diskPath),
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
    // Use diskPath (absolute filesystem path) for OCR — NOT the public URL.
    // extractText uses Tesseract which reads from disk, not HTTP.
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

    // ── Step 5: Liveness check ────────────────────────────────────────────────
    // checkLiveness uses sharp to read image metadata — needs the disk path.
    // const liveness = await checkLiveness(selfieFile.diskPath);     //------------- Temporarily disabled until the service is live
    const liveness = { live: true, reason: 'Liveness service not yet available' };

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
        // + (liveness.live    ? 0.10 : 0)  //------------------ Temporarily disabled until the service is live
        ,
      1.0
    );

    // Hard override: liveness failure always rejects regardless of score
    let decision = getKycDecision(finalScore);
    // if (!liveness.live) decision = 'reject';  //------------------ Temporarily disabled until the service is live

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
// __________________________________________________________             
      // liveness: {
      //   live:   liveness.live,
      //   reason: liveness.reason || null,                  // Temporarily store the liveness service unavailability reason in the KYC record for audit purposes. Remove this when the service is live and stable.
      // },
// ----------------------------------------------------------
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

    // console.log('KYC DEBUG:', {
    //   aadhaarData,
    //   panData,
    //   panApiName: panVerification.name,
    //   userName: user.name,
    //   baseScore,
    //   finalScore
    // });

    await user.save();

    // ── Step 10: Notifications + event bus ───────────────────────────────────
    // Notifications and bus events are non-fatal — failures must never abort
    // the KYC flow or cause a 500. bus.emit can throw when platformEventBus
    // tries to persist to a model that doesn't exist yet (missing migration).
    // ── Notifications + Events ───────────────────
    await kycNotify(userId, 'submitted');

    // ✅ Event Bus
    bus.emit(bus.EVENTS.KYC_SUBMITTED, {
      userId: String(userId),
      decision,
      score: finalScore,
    });

    // ✅ Realtime
    emitKycRealtime("submitted", {
      kycId: String(user._id),
    });

    // Auto-approved: send verified notification immediately
    if (decision === 'auto_approve') {
      await kycNotify(userId, 'auto_verified');

      bus.emit(bus.EVENTS.KYC_VERIFIED, {
        userId: String(userId),
      });

      emitKycRealtime("approved", {
        kycId: String(user._id),
      });
    }

    // Auto-rejected: send rejection notification
    if (decision === 'reject') {
      await kycNotify(userId, 'rejected');

      bus.emit(bus.EVENTS.KYC_REJECTED, {
        userId: String(userId),
        reason: user.kyc.rejectionReason,
      });

      emitKycRealtime("rejected", {
        kycId: String(user._id),
      });
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

    // Trigger special-offer referral reward for the referrer (if any).
    // BUG FIX: The original guard checked `user.kyc?.status === 'verified'`
    // AFTER setting it to 'verified' — so it was always true, making the
    // condition meaningless. Now we simply check `user.referral` directly,
    // which is the actual gating condition.
    if (user.referral) {
      creditReferralReward(user.referral, user._id).catch(err =>
        console.error('[specialOffer] creditReferralReward failed:', err.message)
      );
    }
     
    await kycNotify(user._id, 'admin_verified');

    try {
      bus.emit(bus.EVENTS.KYC_VERIFIED, {
        userId:     String(user._id),
        approvedBy: String(req.user.id),
      });

      emitKycRealtime("approved", {
        kycId: String(user._id),
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

      emitKycRealtime("rejected", {
        kycId: String(user._id),
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

      emitKycRealtime("reset", {
        kycId: String(user._id),
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/kyc/pending
// Returns all users whose KYC status is 'submitted' (pending review).
// ─────────────────────────────────────────────────────────────────────────────
exports.getPendingKyc = async (req, res) => {
  try {
    const users = await User.find({ 'kyc.status': 'submitted' })
      .select('name email phone kyc.status kyc.submittedAt kyc.documents kyc.thumbnails')
      .sort({ 'kyc.submittedAt': 1 })
      .lean();
 
    return res.json({ users });
  } catch (err) {
    console.error('[adminKyc] getPendingKyc error:', err);
    return res.status(500).json({ message: 'Failed to fetch pending KYC submissions.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/kyc/user/:userId
// Returns full KYC details for a specific user.
// ─────────────────────────────────────────────────────────────────────────────
exports.getKycDetails = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('name email phone kyc referral referralId')
      .lean();
 
    if (!user) return res.status(404).json({ message: 'User not found.' });
 
    return res.json({ user });
  } catch (err) {
    console.error('[adminKyc] getKycDetails error:', err);
    return res.status(500).json({ message: 'Failed to fetch KYC details.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/kyc/verify/:userId
// Approves KYC for a user. Sets kyc.status → 'verified'.
//
// NEW: After approval, attempts to credit ₹100 to the user's referrer
// via specialOfferController.creditReferralReward() if:
//   a) The user has a referrer (user.referral is set), AND
//   b) The referrer's 12-hour offer window is still active.
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyKyc = async (req, res) => {
  try {
    const { userId } = req.params;
 
    const user = await User.findById(userId).select('kyc referral name email');
    if (!user) return res.status(404).json({ message: 'User not found.' });
 
    if (user.kyc?.status === 'verified') {
      return res.status(400).json({ message: 'KYC already verified.' });
    }
 
    // ── Perform verification ──────────────────────────────────────────────
    const now = new Date();
    user.kyc.status     = 'verified';
    user.kyc.verifiedAt = now;
    user.kyc.verifiedBy = req.user.id;
    await user.save();
 
    // ── Notify the user ───────────────────────────────────────────────────
    try {
      await Notification.create({
        user:    userId,
        type:    'custom',
        message: '✅ Your KYC has been verified! You can now withdraw rewards.',
        url:     '/rewards',
      });
 
      getIO()
        .to(userId.toString())
        .emit('kyc_verified', { status: 'verified' });
    } catch (notifyErr) {
      console.debug('[adminKyc] notification failed (non-fatal):', notifyErr.message);
    }
 
    // ── Special Offer: credit referrer if eligible ─────────────────────────
    // This is fire-and-forget from the admin's perspective. The admin gets
    // a 200 regardless of whether the credit succeeds.
    if (user.referral) {
      setImmediate(async () => {
        try {
          const result = await creditReferralReward(user.referral, userId);
          if (result.credited) {
            console.log(
              `[adminKyc] Special offer credit: ₹${result.amount} → referrer ${user.referral} ` +
              `(triggered by KYC verification of ${userId})`
            );
          } else {
            // Not an error — offer may have expired, cap hit, etc.
            console.debug(
              `[adminKyc] Special offer credit skipped for referrer ${user.referral}: ${result.reason}`
            );
          }
        } catch (creditErr) {
          console.error('[adminKyc] creditReferralReward threw (non-fatal):', creditErr.message);
        }
      });
    }
 
    return res.json({
      message: 'KYC verified successfully.',
      userId,
      verifiedAt: now,
    });
  } catch (err) {
    console.error('[adminKyc] verifyKyc error:', err);
    return res.status(500).json({ message: 'Failed to verify KYC.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/kyc/reject/:userId
// Rejects KYC for a user. Sets kyc.status → 'rejected'.
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectSpOfferKyc = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
 
    const user = await User.findById(userId).select('kyc name email');
    if (!user) return res.status(404).json({ message: 'User not found.' });
 
    if (user.kyc?.status === 'rejected') {
      return res.status(400).json({ message: 'KYC already rejected.' });
    }
 
    user.kyc.status          = 'rejected';
    user.kyc.rejectionReason = reason ?? 'Documents could not be verified.';
    await user.save();
 
    // ── Notify the user ───────────────────────────────────────────────────
    try {
      await Notification.create({
        user:    userId,
        type:    'custom',
        message: `❌ Your KYC was rejected. Reason: ${user.kyc.rejectionReason} Please resubmit.`,
        url:     '/kyc',
      });
 
      getIO()
        .to(userId.toString())
        .emit('kyc_rejected', { status: 'rejected', reason: user.kyc.rejectionReason });
    } catch (notifyErr) {
      console.debug('[adminKyc] notification failed (non-fatal):', notifyErr.message);
    }
 
    return res.json({
      message: 'KYC rejected.',
      userId,
      reason: user.kyc.rejectionReason,
    });
  } catch (err) {
    console.error('[adminKyc] rejectKyc error:', err);
    return res.status(500).json({ message: 'Failed to reject KYC.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/kyc/stats
// Summary counts for the admin KYC dashboard widget.
// ─────────────────────────────────────────────────────────────────────────────
exports.getSpOfferKycStats = async (req, res) => {
  try {
    const [submitted, verified, rejected, notStarted] = await Promise.all([
      User.countDocuments({ 'kyc.status': 'submitted' }),
      User.countDocuments({ 'kyc.status': 'verified'  }),
      User.countDocuments({ 'kyc.status': 'rejected'  }),
      User.countDocuments({ 'kyc.status': { $in: ['not_started', 'required'] } }),
    ]);
 
    return res.json({ submitted, verified, rejected, notStarted });
  } catch (err) {
    console.error('[adminKyc] getKycStats error:', err);
    return res.status(500).json({ message: 'Failed to fetch KYC stats.' });
  }
};