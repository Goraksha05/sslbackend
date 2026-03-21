const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────
// 📁 DIRECTORY SETUP
// ─────────────────────────────────────────────
const KYC_UPLOAD_DIR = path.join(__dirname, '../uploads/kyc');

if (!fs.existsSync(KYC_UPLOAD_DIR)) {
  fs.mkdirSync(KYC_UPLOAD_DIR, { recursive: true });
}

// ─────────────────────────────────────────────
// 🧹 CLEANUP HELPER (VERY IMPORTANT)
// ─────────────────────────────────────────────
const cleanupFiles = (files) => {
  try {
    Object.values(files || {}).flat().forEach(file => {
      if (file?.path && fs.existsSync(file.path)) {
        fs.unlink(file.path, (err) => {
          if (err) console.error('Cleanup error:', err.message);
        });
      }
    });
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  }
};

// ─────────────────────────────────────────────
// 📦 STORAGE CONFIG
// ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, KYC_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const cleanName = file.fieldname;

    cb(null, `${req.user.id}_${cleanName}_${Date.now()}${ext}`);
  }
});

// ─────────────────────────────────────────────
// 🔐 FILE VALIDATION
// ─────────────────────────────────────────────
const allowedMimeTypes = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp'
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}`), false);
  }
};

// ─────────────────────────────────────────────
// 📏 LIMITS
// ─────────────────────────────────────────────
const limits = {
  fileSize: 10 * 1024 * 1024 // 10MB
};

// ─────────────────────────────────────────────
// 🚀 MULTER INSTANCE
// ─────────────────────────────────────────────
const kycUpload = multer({
  storage,
  fileFilter,
  limits
}).fields([
  { name: 'aadhaar', maxCount: 1 },
  { name: 'pan', maxCount: 1 },
  { name: 'bank', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]);

// ─────────────────────────────────────────────
// 🧠 MIDDLEWARE WRAPPER
// ─────────────────────────────────────────────
const kycUploadMiddleware = (req, res, next) => {
  kycUpload(req, res, function (err) {

    // 🔴 Multer errors (size, limit, etc.)
    if (err instanceof multer.MulterError) {
      cleanupFiles(req.files); // 🔥 CLEANUP
      return res.status(400).json({
        message: 'Upload error',
        error: err.message
      });
    }

    // 🔴 File validation errors
    if (err) {
      cleanupFiles(req.files); // 🔥 CLEANUP
      return res.status(400).json({
        message: 'File validation failed',
        error: err.message
      });
    }

    const files = req.files || {};

    // 🔴 Missing required files
    if (!files.aadhaar || !files.pan || !files.bank || !files.selfie) {
      cleanupFiles(files); // 🔥 CLEANUP
      return res.status(400).json({
        message: 'All KYC documents required: aadhaar, pan, bank, selfie'
      });
    }

    // ✅ SUCCESS
    next();
  });
};

module.exports = kycUploadMiddleware;