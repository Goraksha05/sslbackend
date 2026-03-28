/**
 * utils/generateThumbnail.js
 */

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

// FIX: Use a dedicated kyc-thumbnails subfolder, NOT chatthumbnail.
// chatthumbnail is for chat message media — KYC thumbnails are a separate concern.
const THUMBNAIL_SUBDIR = "kyc-thumbnails";
const THUMBNAIL_DIR    = path.join(__dirname, "..", "uploads", THUMBNAIL_SUBDIR);

const ensureDirExists = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

ensureDirExists(THUMBNAIL_DIR);

/**
 * Convert an absolute disk path inside the uploads folder to a root-relative
 * URL that Express's static middleware can serve.
 *
 * Example:
 *   "E:\sslapp\uploads\kyc-thumbnails\foo-thumb.jpg"
 *   → "/uploads/kyc-thumbnails/foo-thumb.jpg"
 */
function toPublicUrl(absolutePath) {
  // Normalise separators to forward-slash (handles Windows backslashes)
  const normalised = absolutePath.replace(/\\/g, "/");
  // Find the /uploads/ segment and return everything from there
  const idx = normalised.indexOf("/uploads/");
  if (idx !== -1) {
    return normalised.slice(idx); // "/uploads/kyc-thumbnails/..."
  }
  // Fallback: just the filename served from the thumbnail subdir
  return `/uploads/${THUMBNAIL_SUBDIR}/${path.basename(absolutePath)}`;
}

const generateImageThumbnail = async (inputPath, filename) => {
  const thumbFilename = `${filename}-thumb.jpg`;
  const thumbPath     = path.join(THUMBNAIL_DIR, thumbFilename);
  await sharp(inputPath).resize(320, 320).jpeg({ quality: 75 }).toFile(thumbPath);
  // FIX: return a public URL, not the absolute disk path
  return toPublicUrl(thumbPath);
};

const generatePDFThumbnail = async (pdfPath, filename) => {
  const pdfBytes  = fs.readFileSync(pdfPath);
  const pdfDoc    = await PDFDocument.load(pdfBytes);
  const [page]    = await pdfDoc.getPages();
  const jpegBuffer = await page.renderToBuffer({ format: "jpeg", scale: 1 });

  const thumbFilename = `${filename}-thumb.jpg`;
  const thumbPath     = path.join(THUMBNAIL_DIR, thumbFilename);
  await sharp(jpegBuffer).resize(320, 320).jpeg({ quality: 75 }).toFile(thumbPath);
  // FIX: return a public URL, not the absolute disk path
  return toPublicUrl(thumbPath);
};

/**
 * Generate a thumbnail for an image or PDF file.
 *
 * @param {string} filePath  Absolute path to the source file
 * @param {string} mimeType  MIME type of the source file
 * @returns {Promise<string|null>}  Root-relative public URL, or null for unsupported types
 */
const generateThumbnail = async (filePath, mimeType) => {
  const filename = path.basename(filePath, path.extname(filePath));
  if (mimeType.startsWith("image/")) {
    return await generateImageThumbnail(filePath, filename);
  } else if (mimeType === "application/pdf") {
    return await generatePDFThumbnail(filePath, filename);
  }
  return null;
};

module.exports = generateThumbnail;