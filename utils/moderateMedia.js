// utils/moderateMedia.js
const { RekognitionClient, DetectModerationLabelsCommand } = require('@aws-sdk/client-rekognition');
const fs = require('fs');
const path = require('path');

const client = new RekognitionClient({ region: process.env.AWS_REGION });

async function scanImage(filePath) {
  const Bytes = fs.readFileSync(filePath);
  const cmd = new DetectModerationLabelsCommand({ Image: { Bytes }, MinConfidence: 80 });
  const out = await client.send(cmd);
  const labels = out.ModerationLabels?.map(l => l.Name) || [];
  const maxConfidence = Math.max(0, ...out.ModerationLabels.map(l => l.Confidence||0));
  const isNSFW = labels.some(l => /Explicit Nudity|Sexual|Suggestive/i.test(l));
  return { isNSFW, labels, score: maxConfidence };
}

module.exports = async function moderateMedia(processedMediaLocalPaths){
  const result = { isNSFW:false, labels:[], score:0 };
  for (const fp of processedMediaLocalPaths) {
    const r = await scanImage(fp);
    result.labels.push(...r.labels);
    result.score = Math.max(result.score, r.score);
    result.isNSFW = result.isNSFW || r.isNSFW;
    if(result.isNSFW) break; // early stop
  }
  return result;
};
