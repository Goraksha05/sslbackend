/**
 * controllers/kycValidateController.js
 *
 * Lightweight pre-submission OCR validation.
 * Called by the frontend from the Review step (Step 3) BEFORE the user hits
 * "Submit KYC". It runs OCR on individual uploaded documents and returns
 * structured field-match results so the user can fix mismatches immediately
 * instead of getting a silent server-side rejection after a full upload.
 *
 * Endpoint: POST /api/kyc/validate
 * Auth:     Required (fetchuser middleware)
 * Files:    multipart/form-data — same field names as /api/kyc/submit
 *           aadhaar, pan, bank  (selfie is NOT processed here — liveness
 *           is already handled client-side in KycVerification.jsx)
 * Fields:   aadhaarNumber, panNumber, accountNumber
 *
 * Response 200:
 * {
 *   aadhaar: {
 *     ok:              boolean,   // overall: number extracted AND matches typed
 *     numberExtracted: string|null,
 *     numberMatch:     boolean,
 *     nameExtracted:   string|null,
 *     // error is set when OCR itself failed (image unreadable / wrong doc)
 *     error:           string|null,
 *   },
 *   pan: {
 *     ok:              boolean,
 *     numberExtracted: string|null,
 *     numberMatch:     boolean,
 *     error:           string|null,
 *   },
 *   bank: {
 *     ok:              boolean,
 *     accountFound:    boolean,   // typed account number found anywhere in doc
 *     error:           string|null,
 *   },
 *   allPassed: boolean,
 * }
 *
 * Design principles:
 *  - Non-blocking: validation failures return 200 with ok:false — never 4xx.
 *    The final submit is still allowed; this is advisory, not a hard gate.
 *    (The hard gate lives server-side in submitKYC. The point here is early
 *     feedback so users can self-correct before wasting a full upload.)
 *  - OCR errors (unreadable image, wrong doc type) are surfaced as
 *    `error` strings, not thrown exceptions.
 *  - Uploaded files are cleaned up after processing regardless of result.
 *  - Each document is processed independently; one failure doesn't abort others.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  extractText,
  extractAadhaar,
  extractPAN,
} = require('../services/kycOCRService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise a string for comparison: lowercase, strip non-alphanumeric, trim.
 */
function norm(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[\s\-]/g, '');
}

/**
 * Safely delete a file — non-fatal if it doesn't exist.
 */
function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

/**
 * Run OCR on a single uploaded file and catch any errors.
 * Returns { text: string|null, error: string|null }
 */
async function ocrFile(filePath) {
  try {
    const text = await extractText(filePath);
    return { text: text || '', error: null };
  } catch (err) {
    return { text: null, error: `OCR failed: ${err.message}` };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

exports.validateKYC = async (req, res) => {
  // Collect uploaded file paths so we can clean up regardless of outcome
  const uploadedPaths = [];

  try {
    const { aadhaarNumber = '', panNumber = '', accountNumber = '' } = req.body;
    const files = req.files || {};

    const result = {
      aadhaar:   { ok: false, numberExtracted: null, numberMatch: false, nameExtracted: null, error: null },
      pan:       { ok: false, numberExtracted: null, numberMatch: false, error: null },
      bank:      { ok: false, accountFound: false, error: null },
      allPassed: false,
    };

    // ── Aadhaar ────────────────────────────────────────────────────────────────
    if (files.aadhaar?.[0]) {
      const aadhaarPath = files.aadhaar[0].path;
      uploadedPaths.push(aadhaarPath);

      const { text, error } = await ocrFile(aadhaarPath);

      if (error) {
        result.aadhaar.error = 'Could not read the Aadhaar image. Please upload a clearer photo.';
      } else if (!text || text.trim().length < 20) {
        result.aadhaar.error =
          'No text detected in the Aadhaar image. ' +
          'Please check you uploaded the correct document (front of Aadhaar card).';
      } else {
        const aadhaarData = extractAadhaar(text);

        result.aadhaar.numberExtracted = aadhaarData.aadhaarNumber || null;
        result.aadhaar.nameExtracted   = aadhaarData.name          || null;

        if (!aadhaarData.aadhaarNumber) {
          // OCR ran but found no 12-digit number — likely wrong document
          result.aadhaar.error =
            'No Aadhaar number (12 digits) found in the uploaded image. ' +
            'Make sure you uploaded the front side of your Aadhaar card.';
        } else {
          // Compare extracted number against user-typed number (both normalised)
          const typed    = norm(aadhaarNumber).replace(/\D/g, '');
          const extracted = norm(aadhaarData.aadhaarNumber).replace(/\D/g, '');

          result.aadhaar.numberMatch = typed.length === 12 && extracted === typed;

          if (!result.aadhaar.numberMatch) {
            result.aadhaar.error =
              `The Aadhaar number on the document (${
                aadhaarData.aadhaarNumber
              }) does not match the number you typed (${
                aadhaarNumber.replace(/\s/g, '')
              }). Please re-enter your correct Aadhaar number or upload the right document.`;
          } else {
            result.aadhaar.ok = true;
          }
        }
      }
    } else {
      // No file provided — skip (submit will catch missing files)
      result.aadhaar.error = 'No Aadhaar document uploaded.';
    }

    // ── PAN ────────────────────────────────────────────────────────────────────
    if (files.pan?.[0]) {
      const panPath = files.pan[0].path;
      uploadedPaths.push(panPath);

      const { text, error } = await ocrFile(panPath);

      if (error) {
        result.pan.error = 'Could not read the PAN card image. Please upload a clearer photo.';
      } else if (!text || text.trim().length < 10) {
        result.pan.error =
          'No text detected in the PAN image. ' +
          'Please check you uploaded the correct document (PAN card).';
      } else {
        const panData = extractPAN(text);

        result.pan.numberExtracted = panData.panNumber || null;

        if (!panData.panNumber) {
          result.pan.error =
            'No PAN number (AAAAA9999A format) found in the uploaded image. ' +
            'Make sure you uploaded a valid PAN card.';
        } else {
          const typed     = norm(panNumber).replace(/\s/g, '').toUpperCase();
          const extracted = (panData.panNumber || '').toUpperCase();

          result.pan.numberMatch = typed.length === 10 && extracted === typed;

          if (!result.pan.numberMatch) {
            result.pan.error =
              `The PAN number on the document (${extracted}) does not match the number you typed (${panNumber.toUpperCase()}). ` +
              'Please re-enter your correct PAN number or upload the right document.';
          } else {
            result.pan.ok = true;
          }
        }
      }
    } else {
      result.pan.error = 'No PAN document uploaded.';
    }

    // ── Bank Passbook / Statement ──────────────────────────────────────────────
    if (files.bank?.[0]) {
      const bankPath = files.bank[0].path;
      uploadedPaths.push(bankPath);

      const { text, error } = await ocrFile(bankPath);

      if (error) {
        result.bank.error =
          'Could not read the bank passbook image. Please upload a clearer photo.';
      } else if (!text || text.trim().length < 10) {
        result.bank.error =
          'No text detected in the bank document. ' +
          'Please check you uploaded the first page of your passbook or statement.';
      } else {
        const cleanText = norm(text);
        const typedAcct = norm(accountNumber).replace(/\D/g, '');

        if (!typedAcct || typedAcct.length < 9) {
          // Can't compare if the typed field is empty/too short — mark as skipped
          result.bank.ok    = true; // soft pass — field validation catches this
          result.bank.error = null;
        } else if (cleanText.includes(typedAcct)) {
          result.bank.ok           = true;
          result.bank.accountFound = true;
        } else {
          // Try partial match (last 6 digits) to handle masked account numbers
          const last6 = typedAcct.slice(-6);
          if (last6.length === 6 && cleanText.includes(last6)) {
            result.bank.ok           = true;
            result.bank.accountFound = true;
          } else {
            result.bank.error =
              'Your bank account number was not found in the uploaded document. ' +
              'Please upload the first page of your passbook or a bank statement that clearly shows your account number.';
          }
        }
      }
    } else {
      result.bank.error = 'No bank document uploaded.';
    }

    // ── Overall ────────────────────────────────────────────────────────────────
    result.allPassed = result.aadhaar.ok && result.pan.ok && result.bank.ok;

    return res.status(200).json(result);

  } catch (err) {
    console.error('[validateKYC]', err);
    return res.status(500).json({
      message: 'Validation failed due to a server error. You can still submit — our team will review your documents.',
    });
  } finally {
    // Always clean up temporary uploads from this validate call
    uploadedPaths.forEach(safeUnlink);
  }
};