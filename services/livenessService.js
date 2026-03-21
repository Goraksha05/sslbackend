const sharp = require('sharp');

// Simple heuristic (can upgrade later to AI model)
async function checkLiveness(imagePath) {
  try {
    const meta = await sharp(imagePath).metadata();

    // Rule 1: resolution check (low-res = fake)
    if (meta.width < 200 || meta.height < 200) {
      return { live: false, reason: 'Low resolution' };
    }

    // Rule 2: blur detection
    const stats = await sharp(imagePath).stats();
    const variance = stats.channels[0].stdev;

    if (variance < 10) {
      return { live: false, reason: 'Image too smooth (possible screen/photo)' };
    }

    return { live: true };

  } catch (err) {
    return { live: false, reason: 'Liveness check failed' };
  }
}

module.exports = { checkLiveness };