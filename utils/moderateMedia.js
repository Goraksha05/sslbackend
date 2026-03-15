/**
 * utils/moderateMedia.js — Content Moderation via AWS Rekognition
 *
 * Changes from original:
 *  ✅ Async file read (was fs.readFileSync — blocked the event loop)
 *  ✅ Graceful skip when AWS credentials are not configured
 *  ✅ Error handling per-file (one bad file doesn't abort all scans)
 *  ✅ Exported NSFW_PATTERNS for easy extension
 */

const { RekognitionClient, DetectModerationLabelsCommand } = require('@aws-sdk/client-rekognition');
const fs = require('fs').promises;

// ── AWS credential guard ──────────────────────────────────────────────────────
const AWS_CONFIGURED =
  !!process.env.AWS_REGION &&
  !!process.env.AWS_ACCESS_KEY_ID &&
  !!process.env.AWS_SECRET_ACCESS_KEY;

if (!AWS_CONFIGURED) {
  console.warn('[moderateMedia] ⚠️  AWS credentials not set — content moderation is DISABLED.');
}

const client = AWS_CONFIGURED
  ? new RekognitionClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

/** Labels that constitute NSFW content */
const NSFW_PATTERNS = /Explicit Nudity|Sexual|Suggestive/i;

/**
 * Scan a single image file for moderation labels.
 * @param {string} filePath  Absolute path to the image file
 * @returns {Promise<{ isNSFW: boolean, labels: string[], score: number }>}
 */
async function scanImage(filePath) {
  if (!client) {
    // Moderation disabled — allow all content
    return { isNSFW: false, labels: [], score: 0 };
  }

  try {
    // FIX: Use async read to avoid blocking the event loop
    const Bytes = await fs.readFile(filePath);

    const cmd = new DetectModerationLabelsCommand({
      Image:         { Bytes },
      MinConfidence: 80,
    });

    const out    = await client.send(cmd);
    const labels = (out.ModerationLabels ?? []).map((l) => l.Name);
    const scores = (out.ModerationLabels ?? []).map((l) => l.Confidence ?? 0);
    const maxScore = scores.length ? Math.max(...scores) : 0;
    const isNSFW   = labels.some((l) => NSFW_PATTERNS.test(l));

    return { isNSFW, labels, score: maxScore };
  } catch (err) {
    console.error(`[moderateMedia] ❌ Failed to scan ${filePath}:`, err.message);
    // Fail open: if Rekognition errors, don't block the upload
    return { isNSFW: false, labels: [], score: 0 };
  }
}

/**
 * Scan an array of local file paths.
 * Stops early if any file is flagged NSFW.
 *
 * @param {string[]} localFilePaths
 * @returns {Promise<{ isNSFW: boolean, labels: string[], score: number }>}
 */
module.exports = async function moderateMedia(localFilePaths) {
  const result = { isNSFW: false, labels: [], score: 0 };

  for (const fp of localFilePaths) {
    const r = await scanImage(fp);
    result.labels.push(...r.labels);
    result.score  = Math.max(result.score, r.score);
    result.isNSFW = result.isNSFW || r.isNSFW;
    if (result.isNSFW) break; // early stop
  }

  return result;
};

module.exports.NSFW_PATTERNS = NSFW_PATTERNS;
module.exports.scanImage      = scanImage;