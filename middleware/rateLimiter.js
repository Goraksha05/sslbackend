/**
 * middleware/rateLimiter.js — Production Rate Limiters
 *
 * Install: npm install express-rate-limit
 *
 * Three limiters:
 *  - authLimiter : For /api/auth (login, register) — strict
 *  - otpLimiter  : For /api/otp (OTP request/verify) — very strict
 *  - apiLimiter  : General API fallback — generous
 */

const rateLimit = require('express-rate-limit');

/** Shared message format for rate limit responses */
const rateLimitMessage = (action) => ({
  success: false,
  message: `Too many ${action} attempts. Please try again later.`,
});

/**
 * Auth rate limiter — login & registration
 * 10 requests per 15 minutes per IP
 */
const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              10,
  standardHeaders:  true,           // Return rate limit info in `RateLimit-*` headers
  legacyHeaders:    false,
  skipSuccessfulRequests: false,
  message: rateLimitMessage('login/register'),
  handler: (req, res, _next, options) => {
    console.warn(`[rateLimiter] Auth limit hit: ${req.ip} → ${req.originalUrl}`);
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * OTP rate limiter — OTP send & verify
 * 5 requests per hour per IP
 */
const otpLimiter = rateLimit({
  windowMs:        60 * 60 * 1000, // 1 hour
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: rateLimitMessage('OTP'),
  handler: (req, res, _next, options) => {
    console.warn(`[rateLimiter] OTP limit hit: ${req.ip} → ${req.originalUrl}`);
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * General API limiter — broad protection
 * 300 requests per 10 minutes per IP
 */
const apiLimiter = rateLimit({
  windowMs:        10 * 60 * 1000, // 10 minutes
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => {
    // Skip rate limit for health check
    return req.path === '/health';
  },
  message: rateLimitMessage('API'),
});

module.exports = { authLimiter, otpLimiter, apiLimiter };