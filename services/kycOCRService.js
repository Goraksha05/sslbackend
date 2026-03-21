const Tesseract = require('tesseract.js');

async function extractText(filePath) {
  const { data: { text } } = await Tesseract.recognize(filePath, 'eng');
  return text;
}

// Aadhaar extraction
function extractAadhaar(text) {
  const aadhaarMatch = text.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/);
  const nameMatch = text.match(/Name[:\s]+([A-Z ]{3,})/i);

  return {
    aadhaarNumber: aadhaarMatch?.[0]?.replace(/\s/g, '') || null,
    name: nameMatch?.[1]?.trim() || null
  };
}

// PAN extraction
function extractPAN(text) {
  const panMatch = text.match(/[A-Z]{5}[0-9]{4}[A-Z]{1}/);

  return {
    panNumber: panMatch?.[0] || null
  };
}

module.exports = {
  extractText,
  extractAadhaar,
  extractPAN
};