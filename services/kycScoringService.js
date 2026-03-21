/**
 * services/kycScoringService.js
 *
 * KYC document scoring logic.
 * Required by adminKycController.js (was missing entirely in the original codebase).
 *
 * Scoring model:
 *   - Aadhaar number extracted        → +0.30
 *   - PAN number extracted            → +0.20
 *   - PAN API name vs user name match → up to +0.25 (proportional)
 *   - Aadhaar name vs user name match → up to +0.25 (proportional)
 *   Total max base score: 1.0
 *
 *   Bonuses applied by caller (adminKycController):
 *   - Face match          → +0.20
 *   - Liveness passed     → +0.10
 *   Grand total cap: 1.0
 *
 * Decision thresholds:
 *   >= 0.85  → auto_approve
 *   >= 0.55  → manual_review
 *   <  0.55  → reject
 */

'use strict';

// ── Name token comparison ─────────────────────────────────────────────────────
/**
 * Compares two name strings by overlapping tokens.
 * Returns a score between 0 (no overlap) and 1 (full match).
 *
 * @param {string|null} a
 * @param {string|null} b
 * @returns {number}
 */
function nameMatchScore(a, b) {
  if (!a || !b) return 0;

  const tokenise = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')   // strip punctuation
      .split(/\s+/)
      .filter(Boolean);

  const tokA = tokenise(a);
  const tokB = tokenise(b);

  if (tokA.length === 0 || tokB.length === 0) return 0;

  const setB   = new Set(tokB);
  const common = tokA.filter(t => setB.has(t)).length;

  // Jaccard-style: intersect / union
  const union = new Set([...tokA, ...tokB]).size;
  return common / union;
}

// ── Main scorer ───────────────────────────────────────────────────────────────
/**
 * Compute the base KYC score from OCR + PAN API data.
 *
 * @param {object} params
 * @param {{ aadhaarNumber: string|null, name: string|null }} params.aadhaar   - OCR result from Aadhaar
 * @param {{ panNumber: string|null }}                        params.pan       - OCR result from PAN
 * @param {string|null}                                      params.panApiName - Name returned by PAN verification API
 * @param {string}                                           params.userName   - Registered user name
 * @returns {number} score between 0 and 1
 */
function computeKycScore({ aadhaar, pan, panApiName, userName }) {
  let score = 0;

  // ── Aadhaar number extracted ──────────────────────────────────────────────
  if (aadhaar?.aadhaarNumber && /^\d{12}$/.test(aadhaar.aadhaarNumber)) {
    score += 0.30;
  }

  // ── PAN number extracted ──────────────────────────────────────────────────
  if (pan?.panNumber && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.panNumber)) {
    score += 0.20;
  }

  // ── PAN API name vs user name ─────────────────────────────────────────────
  const panApiMatch = nameMatchScore(panApiName, userName);
  score += panApiMatch * 0.25;

  // ── Aadhaar name vs user name ─────────────────────────────────────────────
  const aadhaarNameMatch = nameMatchScore(aadhaar?.name, userName);
  score += aadhaarNameMatch * 0.25;

  return Math.min(Math.round(score * 1000) / 1000, 1.0);
}

// ── Decision ──────────────────────────────────────────────────────────────────
const THRESHOLDS = {
  AUTO_APPROVE:   0.85,
  MANUAL_REVIEW:  0.55,
};

/**
 * Map a final score to a decision string.
 *
 * @param {number} finalScore  - score AFTER adding face-match / liveness bonuses
 * @returns {'auto_approve'|'manual_review'|'reject'}
 */
function getKycDecision(finalScore) {
  if (finalScore >= THRESHOLDS.AUTO_APPROVE)  return 'auto_approve';
  if (finalScore >= THRESHOLDS.MANUAL_REVIEW) return 'manual_review';
  return 'reject';
}

module.exports = {
  computeKycScore,
  getKycDecision,
  nameMatchScore,
  THRESHOLDS,
};