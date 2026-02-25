// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// MIME types
const ALLOWED_MIME_TYPES = {
    image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    video: ["video/mp4", "video/webm", "video/mpeg"],
    audio: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg"],
    document: [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
    ],
};
const ALL_ALLOWED_TYPES = Object.values(ALLOWED_MIME_TYPES).flat();

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 100MB
const BASE_UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const ensureDirExists = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const generatePublicUrl = (filePath) => {
    const relative = filePath.replace(BASE_UPLOADS_DIR, "").replace(/\\/g, "/");
    //  return `https://api.sosholife.com/uploads${relative}`;
    return `https://api.sosholife.com/uploads${relative}`;
};

const createUploadMiddleware = (subDir = "profiles") => {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const userId = req.user?.id || "anonymous";
            const dir = path.join(BASE_UPLOADS_DIR, subDir, userId);
            ensureDirExists(dir);
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            const base = path.basename(file.originalname, ext)
                .replace(/[^a-zA-Z0-9]/g, "_")
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
                cb(new Error("Unsupported file type"), false);
            }
        },
    });
};

// Exports
//const upload = createUploadMiddleware("profiles").single("media");
//const uploadMultiple = (fieldName, maxCount = 5) =>
//  createUploadMiddleware("chatmedia").array(fieldName, maxCount);
// Generic multiple upload middleware by folder type

const uploadMultiple = (fieldName, maxCount = 5, subDir = "profiles") =>
    createUploadMiddleware(subDir).array(fieldName, maxCount);


const uploadProfile = createUploadMiddleware("profiles").single("media");
const uploadChatMedia = (fieldName, maxCount = 5) =>
    createUploadMiddleware("chatmedia").array(fieldName, maxCount);
const uploadPostMedia = (fieldName, maxCount = 5) =>
    createUploadMiddleware("postmedia").array(fieldName, maxCount);

module.exports = {
    uploadProfile,
    uploadChatMedia,
    uploadPostMedia,
    uploadMultiple,
    createUploadMiddleware,
    generatePublicUrl,
    ALLOWED_MIME_TYPES,
};

