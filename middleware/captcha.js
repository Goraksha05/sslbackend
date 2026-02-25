// middleware/captcha.js
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
        secret: process.env.RECAPTCHA_SECRET,
        response: token,
      }),
    });

    const data = await r.json();
    if (!data.success || (data.score && data.score < 0.5)) {
      return res.status(403).json({ message: "Captcha failed" });
    }

    next();
  } catch (err) {
    console.error("Captcha error:", err);
    return res.status(500).json({ message: "Captcha verification failed" });
  }
};
