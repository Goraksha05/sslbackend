// middleware/captcha.js
//
// Works with reCAPTCHA v2 ("I'm not a robot" checkbox).
//
// CHANGE FROM v3:
//   - Removed the `data.score < 0.5` check — reCAPTCHA v2 does not return a
//     score. v2 responses only have a boolean `success` field. Keeping the
//     score check would silently pass all v2 responses (score is undefined,
//     undefined < 0.5 is false) which is confusing; removing it is correct.
//   - Everything else (token field name, siteverify URL, secret env var) is
//     identical between v2 and v3, so no other backend changes are needed.
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

module.exports = async (req, res, next) => {
  const token = req.body.captchaToken;
  if (!token) {
    return res.status(400).json({ message: "Captcha token missing" });
  }

  try {
    const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: process.env.V2_RECAPTCHA_SECRET,
        response: token,
      }),
    });

    const data = await r.json();
    console.log("🔍 CAPTCHA RESPONSE:", data);

    // reCAPTCHA v2: success is a boolean — no score field
    if (!data.success) {
      return res.status(403).json({ message: "Captcha verification failed. Please try again." });
    }

    next();
  } catch (err) {
    console.error("Captcha error:", err);
    return res.status(500).json({ message: "Captcha verification failed" });
  }
};