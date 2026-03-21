const path = require("path");
const fs  = require("fs");
const fsp = require("fs/promises");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { fromPath } = require("pdf2pic");
const libre = require("libreoffice-convert");
const util = require("util");
libre.convertAsync = util.promisify(libre.convert);

ffmpeg.setFfmpegPath(ffmpegPath);

// Disable libvips tile cache so sharp releases file handles immediately after
// a pipeline completes. Without this on Windows, the OS returns EPERM when
// we try to unlink the source file right after sharp finishes writing output.
sharp.cache(false);

/**
 * Unlink a file with retry on EPERM/EBUSY (Windows file-handle timing issue).
 * Sharp and antivirus scanners can briefly hold a handle after the async
 * pipeline resolves. A short back-off is enough to clear it.
 */
async function unlinkRetry(filePath, retries = 5, delayMs = 120) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fsp.unlink(filePath);
      return;
    } catch (err) {
      const retryable = err.code === "EPERM" || err.code === "EBUSY";
      if (!retryable || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

/**
 * Rename a file with retry on EPERM/EBUSY.
 */
async function renameRetry(src, dest, retries = 5, delayMs = 120) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fsp.rename(src, dest);
      return;
    } catch (err) {
      const retryable = err.code === "EPERM" || err.code === "EBUSY";
      if (!retryable || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

// Guess mimetype if multer didn’t provide it
const guessMimeType = (ext) => {
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
};

const compressFile = async (filePath, mimetype) => {
  let ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  let outputPath = path.join(dir, `${base}-compressed${ext}`);
  const thumbnails = [];

  // ✅ Ensure mimetype is always defined
  if (!mimetype) {
    mimetype = guessMimeType(ext);
  }

  try {
    // === IMAGES ===
    if (mimetype.startsWith("image/")) {
      await sharp(filePath)
        .rotate()
        .resize({ width: 1080, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toFile(outputPath);

    // === VIDEOS ===
    } else if (mimetype.startsWith("video/")) {
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .videoCodec("libx264")
          .size("640x?")
          .outputOptions("-crf 28")
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      const thumbnailPath = path.join(dir, `${base}-thumb.jpg`);
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .screenshots({
            timestamps: ["00:00:01"],
            filename: path.basename(thumbnailPath),
            folder: dir,
            size: "320x240",
          })
          .on("end", resolve)
          .on("error", reject);
      });
      thumbnails.push(thumbnailPath);

    // === DOCX -> PDF ===
    } else if (
      mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const docxBuf = fs.readFileSync(filePath);
      const pdfBuf = await libre.convertAsync(docxBuf, ".pdf", undefined);
      const pdfPath = path.join(dir, `${base}.pdf`);
      fs.writeFileSync(pdfPath, pdfBuf);
      await unlinkRetry(filePath);
      filePath = pdfPath;
      outputPath = path.join(dir, `${base}-compressed.pdf`);
      ext = ".pdf";
      mimetype = "application/pdf";
    }

    // === PDF ===
    if (mimetype === "application/pdf" || outputPath.endsWith(".pdf")) {
      await sharp({
        density: 100,
        pages: 1,
        limitInputPixels: false,
        failOnError: false,
        input: filePath,
      })
        .jpeg({ quality: 70 })
        .toFile(outputPath);

      const thumbnailPath = path.join(dir, `${base}-thumb.jpg`);
      const converter = fromPath(filePath, {
        density: 100,
        saveFilename: `${base}-thumb`,
        savePath: dir,
        format: "jpeg",
        width: 320,
        height: 240,
      });
      await converter(1);
      thumbnails.push(thumbnailPath);
    }

    // Replace original with compressed
    // Both operations are async+retry to avoid EPERM on Windows where
    // sharp or antivirus can briefly hold the source file handle.
    if (fs.existsSync(outputPath)) {
      await unlinkRetry(filePath);
      await renameRetry(outputPath, filePath);
    }

    // Cleanup old thumbs
    fs.readdirSync(dir).forEach((file) => {
      if (
        file.includes(`${base}-thumb`) &&
        !thumbnails.includes(path.join(dir, file))
      ) {
        // Best-effort cleanup — ignore errors (non-critical stale thumbs)
        try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
      }
    });

    return { filePath, mimetype, thumbnails };
  } catch (error) {
    console.error("Compression failed for", filePath, ":", error);
    // Fallback: return original file so we don’t 500
    return { filePath, mimetype, thumbnails: [] };
  }
};

module.exports = compressFile;