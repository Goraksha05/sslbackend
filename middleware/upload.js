// middleware/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = {
    image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    video: ['video/mp4', 'video/webm', 'video/mpeg'],
    audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg'],
    document: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
    ],
};
const ALL_ALLOWED_TYPES = Object.values(ALLOWED_MIME_TYPES).flat();

const MAX_FILE_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '100', 10) * 1024 * 1024;

const BASE_UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// ── Helpers ──────────────────────────────────────────────────────────────────

const ensureDirExists = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

/**
 * Build the public URL for an uploaded file.
 *
 * Priority order:
 *   1. UPLOADS_BASE_URL env var  (explicit override — good for reverse-proxy setups)
 *   2. Production default        (https://api.sosholife.com)
 *   3. Development fallback      (derived from the incoming request)
 *
 * In development set UPLOADS_BASE_URL=http://localhost:5001 in your .env so
 * local file URLs are reachable. In production set it to https://api.sosholife.com
 * (or wherever your static /uploads folder is actually served from).
 */
const getUploadsBaseUrl = (req) => {
    // 1. Explicit env override — highest priority, works for CDN / proxy setups
    if (process.env.UPLOADS_BASE_URL) {
        return process.env.UPLOADS_BASE_URL.replace(/\/$/, '');
    }
    // 2. Production mode without explicit override
    if (process.env.NODE_ENV === 'production') {
        return 'https://api.sosholife.com';
    }
    // 3. Development: derive from the current request
    if (req) {
        return `${req.protocol}://${req.get('host')}`;
    }
    // 4. Last-resort fallback
    return 'http://localhost:5001';
};

const generatePublicUrl = (req, subDir, userId, filename) => {
    const base = getUploadsBaseUrl(req);
    return `${base}/uploads/${subDir}/${userId}/${filename}`;
};

// ── Core factory ─────────────────────────────────────────────────────────────

const createUploadMiddleware = (subDir = 'profiles') => {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const userId = req.user?.id || 'anonymous';
            const dir = path.join(BASE_UPLOADS_DIR, subDir, userId);
            ensureDirExists(dir);
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            const base = path
                .basename(file.originalname, ext)
                .replace(/[^a-zA-Z0-9]/g, '_')
                .toLowerCase();
            cb(null, `${Date.now()}-${base}${ext}`);
        },
    });

    return multer({
        storage,
        limits: { fileSize: MAX_FILE_SIZE },
        fileFilter: (req, file, cb) => {
            if (ALL_ALLOWED_TYPES.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
            }
        },
    });
};

// ── Named exports ─────────────────────────────────────────────────────────────

const uploadProfile = createUploadMiddleware('profiles').single('media');

const uploadChatMedia = (fieldName, maxCount = 5) =>
    createUploadMiddleware('chatmedia').array(fieldName, maxCount);

const uploadPostMedia = (fieldName, maxCount = 5) =>
    createUploadMiddleware('postmedia').array(fieldName, maxCount);

const uploadMultiple = (fieldName, maxCount = 5, subDir = 'profiles') =>
    createUploadMiddleware(subDir).array(fieldName, maxCount);

module.exports = {
    uploadProfile,
    uploadChatMedia,
    uploadPostMedia,
    uploadMultiple,
    createUploadMiddleware,
    generatePublicUrl,
    getUploadsBaseUrl,
    ALLOWED_MIME_TYPES,
};