// middleware/captchaHybrid.js
//
// Hybrid reCAPTCHA middleware — supports v3 (invisible, score-based) with
// automatic v2 ("I'm not a robot" checkbox) fallback.
//
// Flow:
//   v3 → verify score ≥ 0.5 AND action matches → pass
//        score < 0.5 OR action mismatch          → { fallback: "v2_required" }
//   v2 → verify success boolean                  → pass | reject
//
// Secrets:
//   RECAPTCHA_SECRET    — reCAPTCHA v3 secret key
//   V2_RECAPTCHA_SECRET — reCAPTCHA v2 secret key
//
// Request body fields expected:
//   captchaToken  {string}  — the token from grecaptcha.execute() or widget
//   captchaType   {string}  — "v3" | "v2"
//   captchaAction {string}  — (optional) action name used in v3 execute call
//                             e.g. "login" | "signup"
//                             Defaults to no action check if omitted.

const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const V3_MIN_SCORE   = 0.5;

module.exports = async (req, res, next) => {
  const { captchaToken, captchaType, captchaAction } = req.body;

  // ── Token presence guard ─────────────────────────────────────────────────
  if (!captchaToken) {
    return res.status(400).json({ message: "Captcha token missing" });
  }

  // ── Type guard ───────────────────────────────────────────────────────────
  const type = (captchaType || "v2").toLowerCase();
  if (type !== "v3" && type !== "v2") {
    return res.status(400).json({ message: "Invalid captchaType. Expected 'v3' or 'v2'." });
  }

  // ── Select secret based on type ──────────────────────────────────────────
  const secret = type === "v3"
    ? process.env.RECAPTCHA_SECRET        // v3 secret
    : process.env.V2_RECAPTCHA_SECRET;    // v2 secret

  if (!secret) {
    console.error(`[captchaHybrid] Missing env var: ${type === "v3" ? "RECAPTCHA_SECRET" : "V2_RECAPTCHA_SECRET"}`);
    return res.status(500).json({ message: "Captcha configuration error" });
  }

  try {
    const r = await fetch(SITEVERIFY_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({ secret, response: captchaToken }),
    });

    const data = await r.json();
    console.log(`[captchaHybrid] type=${type}`, data);

    // ── v3 verification ────────────────────────────────────────────────────
    if (type === "v3") {
      // v3 siteverify returns { success, score, action, challenge_ts, hostname }
      if (!data.success) {
        // Token invalid / expired — ask for v2 fallback
        return res.status(403).json({ fallback: "v2_required" });
      }

      // Optional action validation — prevents token reuse across endpoints
      // (e.g. a token minted for "login" cannot pass a "signup" check).
      if (captchaAction && data.action && data.action !== captchaAction) {
        console.warn(`[captchaHybrid] v3 action mismatch: expected=${captchaAction} got=${data.action}`);
        return res.status(403).json({ fallback: "v2_required" });
      }

      const score = typeof data.score === "number" ? data.score : 0;

      if (score < V3_MIN_SCORE) {
        // Low confidence — fall back to visible v2 challenge
        return res.status(403).json({ fallback: "v2_required" });
      }

      // High-confidence v3 pass — attach score for downstream logging
      req.captchaScore = score;
      return next();
    }

    // ── v2 verification ────────────────────────────────────────────────────
    // v2 siteverify returns { success, challenge_ts, hostname, error-codes? }
    // No score field — success is purely boolean.
    if (!data.success) {
      return res.status(403).json({ message: "Captcha verification failed. Please try again." });
    }

    return next();

  } catch (err) {
    console.error("[captchaHybrid] Verification error:", err);
    return res.status(500).json({ message: "Captcha verification failed" });
  }
};