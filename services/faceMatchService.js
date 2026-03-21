global.fetch = require('node-fetch');
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;

  await faceapi.nets.ssdMobilenetv1.loadFromDisk('./models');
  await faceapi.nets.faceRecognitionNet.loadFromDisk('./models');
  await faceapi.nets.faceLandmark68Net.loadFromDisk('./models');

  modelsLoaded = true;
}

async function getDescriptor(imagePath) {
  const img = await canvas.loadImage(imagePath);

  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return null;

  return detection.descriptor;
}

function euclideanDistance(d1, d2) {
  return Math.sqrt(d1.reduce((sum, val, i) => sum + (val - d2[i]) ** 2, 0));
}

async function compareFaces(img1, img2) {
  await loadModels();

  const desc1 = await getDescriptor(img1);
  const desc2 = await getDescriptor(img2);

  if (!desc1 || !desc2) {
    return { match: false, score: 0 };
  }

  const distance = euclideanDistance(desc1, desc2);

  // Lower = better match
  const score = 1 - distance;

  return {
    match: distance < 0.6,
    score
  };
}

module.exports = { compareFaces };