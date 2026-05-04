'use strict';

const Tesseract = require('tesseract.js');

async function extractText(filePath) {
  const { data: { text } } = await Tesseract.recognize(filePath, 'eng');
  return text;
}

// ── Aadhaar extraction ────────────────────────────────────────────────────────

/**
 * Known UIDAI boilerplate words that appear in disclaimer text on the
 * front and back of Aadhaar cards.  Any candidate line containing one of
 * these words is immediately rejected as a name.
 *
 * Front-of-card common boilerplate:
 *   "Government of India", "Unique Identification Authority"
 * Back-of-card disclaimer (the one that caused the bug):
 *   "This is based on information supported by proof of DOB document"
 *   "My Aadhaar My Identity" / "Mera Aadhaar Meri Pehchaan"
 *   "Enrolment No" / "Enrollment No" / "VID"
 *   "Male" / "Female" / "Transgender"  (gender field)
 *   "Address" / "S/O" / "D/O" / "W/O" / "C/O" / "H/No" / "Village"
 *   "District" / "State" / "PIN" / "Post"
 */
const BOILERPLATE_WORDS = new Set([
  // UIDAI institution words
  'government', 'india', 'authority', 'unique', 'uidai',
  'identification', 'enrolment', 'enrollment',
  // Back-of-card disclaimer vocabulary (the exact set that caused the bug)
  'based', 'information', 'supported', 'proof', 'document',
  'identity', 'aadhaar', 'mera', 'meri', 'pehchaan',
  // Address / relationship indicators
  'address', 'village', 'district', 'state', 'post', 'pin',
  'house', 'near', 'street', 'road', 'nagar', 'colony',
  // Gender values OCR might surface
  'male', 'female', 'transgender',
  // Misc card text
  'vid', 'mobile', 'download', 'resident',
]);

/**
 * Returns true if the candidate string looks like it could be a real name:
 *   - 2 to 4 words
 *   - Each word 2–20 characters, letters/hyphens/apostrophes only
 *   - Total length 4–50 characters
 *   - Does NOT contain any boilerplate vocabulary word
 *   - Is not a single common English word (preposition, article, conjunction)
 */
const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
  'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get',
  'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now',
  'old', 'see', 'two', 'who', 'did', 'she', 'use', 'way',
  'this', 'that', 'with', 'from', 'they', 'been', 'have',
  'were', 'said', 'each', 'which', 'their', 'will', 'other',
  'about', 'there', 'then', 'some', 'these', 'would', 'into',
]);

function looksLikeName(candidate) {
  if (!candidate) return false;

  const trimmed = candidate.trim();
  if (trimmed.length < 4 || trimmed.length > 50) return false;

  // Must not contain digits or special chars other than hyphens/apostrophes/spaces
  if (/[^A-Za-z '\-]/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  for (const word of words) {
    if (word.length < 2 || word.length > 20) return false;
    // Any boilerplate word disqualifies the entire line
    if (BOILERPLATE_WORDS.has(word.toLowerCase())) return false;
    // A word that is a common English word is suspicious in a name context
    if (COMMON_WORDS.has(word.toLowerCase())) return false;
  }

  return true;
}

function extractAadhaar(text) {
  if (!text) return { aadhaarNumber: null, name: null };

  // ── Aadhaar number ──────────────────────────────────────────────────────────
  // Normalise Tesseract's O→0 substitution before matching digits.
  const cleaned = text
    .replace(/\bO\b/g, '0')
    .replace(/O(?=\d)/g, '0')
    .replace(/(\d)O/g, '$10');    // capture the preceding digit, re-emit it

  // Strip date patterns (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY) BEFORE matching
  // the 12-digit Aadhaar number.  Without this, the DOB year bleeds into the
  // match — e.g. "DOB: 12/05/1990\n3897 8877 0681" produces "1990 3897 8877"
  // instead of "3897 8877 0681".
  const withoutDates = cleaned.replace(/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}\b/g, '');

  const aadhaarMatch = withoutDates.match(/\b(\d{4}[\s\-]?\d{4}[\s\-]?\d{4})\b/);
  const aadhaarNumber = aadhaarMatch
    ? aadhaarMatch[1].replace(/[\s\-]/g, '')
    : null;

  // ── Name extraction ─────────────────────────────────────────────────────────
  //
  // Strategy 1 — explicit "Name:" label (most reliable when present).
  //   Capture only the remainder of that line — stop at newline or digit run.
  //   Handles: "Name: Goraksha Khedekar", "Name Goraksha Khedekar"
  //
  // Strategy 2 — structural position relative to DOB.
  //   On the front face of current Aadhaar cards the layout is:
  //     <Name>          ← line ABOVE the DOB
  //     DOB: DD/MM/YYYY
  //   On some older / e-Aadhaar layouts the name is BELOW the DOB line.
  //   We try both directions.
  //
  // Strategy 3 — scored line scan (last resort).
  //   Walk every non-empty line; run looksLikeName() which enforces strict
  //   word count, length, and boilerplate filters.  Take the first match.

  let name = null;

  // Strategy 1 — label match, anchored to single line
  const labelMatch = text.match(
    /(?:^|\n)[^\n]*(?:Name|नाम)\s*[:\-]?\s*([A-Za-z][A-Za-z .'\-]{2,49})(?:\n|$)/im
  );
  if (labelMatch) {
    const candidate = labelMatch[1].trim();
    if (looksLikeName(candidate)) {
      name = candidate;
    }
  }

  // Strategy 2a — line immediately ABOVE the DOB line (most common layout)
  if (!name) {
    const aboveDobMatch = text.match(
      /([A-Za-z][A-Za-z .'\-]{3,49})\n[^\n]*(?:DOB|Date of Birth|Year of Birth)/i
    );
    if (aboveDobMatch) {
      const candidate = aboveDobMatch[1].trim();
      if (looksLikeName(candidate)) {
        name = candidate;
      }
    }
  }

  // Strategy 2b — line immediately BELOW the DOB line (older / e-Aadhaar layout)
  if (!name) {
    const belowDobMatch = text.match(
      /(?:DOB|Date of Birth|Year of Birth)[^\n]*\n\s*([A-Za-z][A-Za-z .'\-]{3,49})/i
    );
    if (belowDobMatch) {
      const candidate = belowDobMatch[1].trim();
      if (looksLikeName(candidate)) {
        name = candidate;
      }
    }
  }

  // Strategy 3 — scored line scan
  if (!name) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (looksLikeName(line)) {
        name = line;
        break;
      }
    }
  }

  return { aadhaarNumber, name };
}

// ── PAN extraction ────────────────────────────────────────────────────────────
function extractPAN(text) {
  if (!text) return { panNumber: null };

  // PAN format: AAAAA9999A (5 alpha, 4 digit, 1 alpha)
  //
  // Pass 1 — raw text match with word boundaries (ideal: no OCR spacing)
  const rawMatch = text.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/);
  if (rawMatch) return { panNumber: rawMatch[1] };

  // Pass 2 — collapse spaces inside PAN-shaped tokens.
  // Tesseract often produces "ABCDE 1234 F" or "AB CDE 1234F".
  // Strategy: extract every run of uppercase letters, digits, and spaces
  // that is between 10 and 14 chars, strip internal spaces, then test.
  const candidates = text.match(/[A-Z][A-Z0-9 ]{9,13}/g) || [];
  for (const candidate of candidates) {
    const compact = candidate.replace(/\s/g, '');
    if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(compact)) {
      return { panNumber: compact };
    }
  }

  // Pass 3 — uppercase-normalise the full text and retry pass 1.
  // Handles lowercase OCR output on some scanned cards.
  const upper = text.toUpperCase();
  const upperMatch = upper.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/);
  if (upperMatch) return { panNumber: upperMatch[1] };

  return { panNumber: null };
}

module.exports = {
  extractText,
  extractAadhaar,
  extractPAN,
  // Exported for unit testing
  looksLikeName,
};