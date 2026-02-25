const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

const THUMBNAIL_DIR = path.join(__dirname, "..", "uploads", "chatthumbnail");

const ensureDirExists = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

ensureDirExists(THUMBNAIL_DIR);

const generateImageThumbnail = async (inputPath, filename) => {
  const thumbPath = path.join(THUMBNAIL_DIR, `${filename}-thumb.jpg`);
  await sharp(inputPath).resize(320, 320).jpeg({ quality: 75 }).toFile(thumbPath);
  return thumbPath;
};

const generatePDFThumbnail = async (pdfPath, filename) => {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const [page] = await pdfDoc.getPages();
  const jpegBuffer = await page.renderToBuffer({ format: "jpeg", scale: 1 });

  const thumbPath = path.join(THUMBNAIL_DIR, `${filename}-thumb.jpg`);
  await sharp(jpegBuffer).resize(320, 320).jpeg({ quality: 75 }).toFile(thumbPath);
  return thumbPath;
};

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