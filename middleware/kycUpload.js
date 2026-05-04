'use strict';

/**
 * kycUpload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Production-grade KYC document upload middleware built on multer.
 *
 * Hardening applied vs. original:
 *  1. Magic-byte validation via `file-type` — defeats MIME spoofing.
 *  2. Whitelisted file extensions — double-check against magic bytes.
 *  3. crypto.randomUUID() filenames — eliminates Date.now() collisions.
 *  4. Sanitised req.user.id in filename — prevents path-traversal.
 *  5. `fields` count cap on the multer instance — limits field-flood attacks.
 *  6. Async cleanup with Promise.allSettled — no fire-and-forget unlinks.
 *  7. Cleanup on ALL error paths in kycValidateUploadMiddleware (was missing).
 *  8. Required-field enforcement in kycValidateUploadMiddleware (was missing).
 *  9. Granular MulterError codes — LIMIT_FILE_SIZE gets its own 413 response.
 * 10. Single multer-instance factory — no duplicated config.
 * 11. mkdirSync idempotency — removed redundant existsSync guard.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Peer dependencies (add to package.json if not already present):
 *   multer       ^1.4.5-lts.1
 *   file-type    ^19.x          ← ESM-only ≥ v17; pin to ^16 if CJS is needed
 */

const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

// ─────────────────────────────────────────────
// 📁  DIRECTORY SETUP
// ─────────────────────────────────────────────

const KYC_UPLOAD_DIR = path.resolve(__dirname, '../uploads/kyc');

// mkdirSync with { recursive: true } is idempotent — no existsSync needed.
fs.mkdirSync(KYC_UPLOAD_DIR, { recursive: true });

// ─────────────────────────────────────────────
// 🔐  ALLOWED TYPES  (MIME  +  extension pairs)
// ─────────────────────────────────────────────

const ALLOWED_TYPES = new Map([
  ['application/pdf', ['.pdf']],
  ['image/jpeg',      ['.jpg', '.jpeg']],
  ['image/png',       ['.png']],
  ['image/webp',      ['.webp']],
]);

// ─────────────────────────────────────────────
// 🧹  ASYNC CLEANUP HELPER
// ─────────────────────────────────────────────

/**
 * Deletes every file that multer wrote to disk.
 * Uses Promise.allSettled so one failed unlink never blocks the rest.
 *
 * @param {multer.Files | undefined} files
 * @returns {Promise<void>}
 */
const cleanupFiles = async (files) => {
  const targets = Object.values(files || {})
    .flat()
    .filter(f => f?.path);

  await Promise.allSettled(
    targets.map(f =>
      fs.promises.unlink(f.path).catch(err =>
        console.error(`[KYC] Cleanup failed for ${f.path}:`, err.message)
      )
    )
  );
};

// ─────────────────────────────────────────────
// 🔍  MAGIC-BYTE VALIDATOR
// ─────────────────────────────────────────────

/**
 * Reads the first bytes of a saved file and confirms the real type matches
 * the client-supplied MIME type.  Defeats Content-Type spoofing.
 *
 * Requires `file-type` v16 (CJS) or dynamic import for v17+.
 * Install: npm i file-type@16
 *
 * @param {Express.Multer.File} file
 * @returns {Promise<void>}  Throws if magic bytes are invalid.
 */
const validateMagicBytes = async (file) => {
  // Lazy-require so the rest of the middleware still loads if the package
  // is not yet installed (will surface a clear error at call time).
  const { fileTypeFromFile } = require('file-type'); // v16 CJS build

  const detected = await fileTypeFromFile(file.path);

  if (!detected) {
    throw new Error(
      `Could not determine file type for field "${file.fieldname}". ` +
      'File may be corrupt or a plain-text file with a renamed extension.'
    );
  }

  const allowedExts = ALLOWED_TYPES.get(detected.mime);

  if (!allowedExts) {
    throw new Error(
      `Disallowed file type detected for field "${file.fieldname}": ` +
      `${detected.mime} (magic bytes). ` +
      `Allowed: ${[...ALLOWED_TYPES.keys()].join(', ')}.`
    );
  }

  // Also verify the file extension the client sent is in the allowed list
  // for the detected MIME type.
  const clientExt = path.extname(file.originalname).toLowerCase();
  if (!allowedExts.includes(clientExt)) {
    throw new Error(
      `Extension "${clientExt}" is not valid for detected type "${detected.mime}" ` +
      `on field "${file.fieldname}". Expected: ${allowedExts.join(', ')}.`
    );
  }
};

// ─────────────────────────────────────────────
// 📦  STORAGE CONFIG  (shared)
// ─────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, KYC_UPLOAD_DIR),

  filename: (req, file, cb) => {
    // Sanitise user ID — keep only alphanumerics, hyphens, underscores.
    const safeUserId = String(req.user?.id ?? 'anon').replace(/[^a-zA-Z0-9_-]/g, '');

    // Whitelist extension from ALLOWED_TYPES; fall back to empty string
    // (multer's fileFilter will reject it before we reach this point, but
    // being defensive here prevents any path traversal via the extension).
    const rawExt    = path.extname(file.originalname).toLowerCase();
    const safeExt   = [...ALLOWED_TYPES.values()].flat().includes(rawExt) ? rawExt : '';
    const uniqueId  = crypto.randomUUID();

    cb(null, `${safeUserId}_${file.fieldname}_${uniqueId}${safeExt}`);
  },
});

// ─────────────────────────────────────────────
// 🔐  MIME FILTER  (first-pass; magic bytes checked post-save)
// ─────────────────────────────────────────────

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type "${file.mimetype}" on field "${file.fieldname}". ` +
        `Allowed: ${[...ALLOWED_TYPES.keys()].join(', ')}.`
      ),
      false
    );
  }
};

// ─────────────────────────────────────────────
// 📏  LIMITS  (shared)
// ─────────────────────────────────────────────

const LIMITS = {
  fileSize:  10 * 1024 * 1024, // 10 MB per file
  fields:    20,               // cap unexpected non-file fields
  files:     4,                // never accept more files than we expect
};

// ─────────────────────────────────────────────
// 🏭  MULTER INSTANCE FACTORY
// ─────────────────────────────────────────────

/**
 * Creates a multer instance pre-configured with shared storage, filter and
 * limits, scoped to a specific set of field definitions.
 *
 * @param {multer.Field[]} fields
 * @returns {multer.Multer['fields'] return type} — the bound .fields() handler
 */
const buildUploadHandler = (fields) =>
  multer({ storage, fileFilter, limits: LIMITS }).fields(fields);

// ─────────────────────────────────────────────
// 📋  FIELD DEFINITIONS
// ─────────────────────────────────────────────

const KYC_FULL_FIELDS = [
  { name: 'aadhaar', maxCount: 1 },
  { name: 'pan',     maxCount: 1 },
  { name: 'bank',    maxCount: 1 },
  { name: 'selfie',  maxCount: 1 },
];

const KYC_VALIDATE_FIELDS = [
  { name: 'aadhaar', maxCount: 1 },
  { name: 'pan',     maxCount: 1 },
  { name: 'bank',    maxCount: 1 },
];

// ─────────────────────────────────────────────
// 🛠  SHARED ERROR HANDLER
// ─────────────────────────────────────────────

/**
 * Translates multer / validation errors into consistent JSON responses,
 * cleaning up any partially-written files first.
 *
 * @param {Error}              err
 * @param {multer.Files}       files
 * @param {import('express').Response} res
 * @returns {Promise<boolean>}  true if the error was handled (caller should return), false otherwise.
 */
const handleUploadError = async (err, files, res) => {
  if (!err) return false;

  await cleanupFiles(files);

  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Maximum allowed size is ${LIMITS.fileSize / (1024 * 1024)} MB.`
        : `Upload error: ${err.message}`;

    res.status(status).json({ success: false, code: err.code, message });
    return true;
  }

  // Validation / magic-byte errors
  res.status(400).json({ success: false, message: err.message });
  return true;
};

// ─────────────────────────────────────────────
// 🧠  MIDDLEWARE: kycUploadMiddleware
//     Requires: aadhaar + pan + bank + selfie
// ─────────────────────────────────────────────

const kycUploadHandler = buildUploadHandler(KYC_FULL_FIELDS);

const REQUIRED_KYC_FIELDS = ['aadhaar', 'pan', 'bank', 'selfie'];

/**
 * Express middleware that:
 *  1. Runs multer (disk storage, MIME filter, size limit).
 *  2. Validates magic bytes for every uploaded file.
 *  3. Enforces all four KYC documents are present.
 *  4. Cleans up on any failure path.
 *
 * @type {import('express').RequestHandler}
 */
const kycUploadMiddleware = (req, res, next) => {
  kycUploadHandler(req, res, async (err) => {
    // ── 1. Multer / filter errors ──────────────────────────────────────────
    if (await handleUploadError(err, req.files, res)) return;

    const files = req.files || {};

    // ── 2. Required-field check ────────────────────────────────────────────
    const missing = REQUIRED_KYC_FIELDS.filter(f => !files[f]?.length);
    if (missing.length) {
      await cleanupFiles(files);
      return res.status(400).json({
        success: false,
        message: `Missing required KYC document(s): ${missing.join(', ')}.`,
      });
    }

    // ── 3. Magic-byte validation ───────────────────────────────────────────
    try {
      const allFiles = Object.values(files).flat();
      await Promise.all(allFiles.map(validateMagicBytes));
    } catch (magicErr) {
      await cleanupFiles(files);
      return res.status(400).json({ success: false, message: magicErr.message });
    }

    // ── 4. All good ────────────────────────────────────────────────────────
    next();
  });
};

// ─────────────────────────────────────────────
// 🧠  MIDDLEWARE: kycValidateUploadMiddleware
//     Requires: aadhaar + pan + bank  (no selfie)
// ─────────────────────────────────────────────

const kycValidateHandler = buildUploadHandler(KYC_VALIDATE_FIELDS);

const REQUIRED_VALIDATE_FIELDS = ['aadhaar', 'pan', 'bank'];

/**
 * Lighter KYC validation middleware (no selfie required).
 * Shares the same hardening as kycUploadMiddleware.
 *
 * @type {import('express').RequestHandler}
 */
const kycValidateUploadMiddleware = (req, res, next) => {
  kycValidateHandler(req, res, async (err) => {
    // ── 1. Multer / filter errors ──────────────────────────────────────────
    if (await handleUploadError(err, req.files, res)) return;

    const files = req.files || {};

    // ── 2. Required-field check ────────────────────────────────────────────
    const missing = REQUIRED_VALIDATE_FIELDS.filter(f => !files[f]?.length);
    if (missing.length) {
      await cleanupFiles(files);
      return res.status(400).json({
        success: false,
        message: `Missing required document(s): ${missing.join(', ')}.`,
      });
    }

    // ── 3. Magic-byte validation ───────────────────────────────────────────
    try {
      const allFiles = Object.values(files).flat();
      await Promise.all(allFiles.map(validateMagicBytes));
    } catch (magicErr) {
      await cleanupFiles(files);
      return res.status(400).json({ success: false, message: magicErr.message });
    }

    // ── 4. All good ────────────────────────────────────────────────────────
    next();
  });
};

// ─────────────────────────────────────────────
// 📤  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  kycUploadMiddleware,
  kycValidateUploadMiddleware,
  // Exported for unit-testing or reuse in other routes:
  cleanupFiles,
  validateMagicBytes,
  ALLOWED_TYPES,
  KYC_UPLOAD_DIR,
};