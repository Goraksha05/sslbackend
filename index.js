/**
 * index.js — SoShoLife Backend Entry Point (Production-Ready)
**/

require('dotenv').config({ override: true });
require('./jobs/accountDeletionJob');
require('./jobs/kycReminderJob');

// ── Startup environment guard ─────────────────────────────────────────────────
const REQUIRED_ENV = [
  'JWT_SECRET',
  'MONGO_URI',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const http = require('http');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cloudinary = require('cloudinary').v2;
const cookieParser = require('cookie-parser');
const { initializeSocket } = require('./sockets/IOsocket');
const { getIO } = require('./sockets/socketManager');
const { authLimiter, otpLimiter, apiLimiter } = require('./middleware/rateLimiter');

const PORT = process.env.PORT || 5000;

const app = express();
const server = http.createServer(app);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
initializeSocket(server);

app.use((req, res, next) => {
  req.io = getIO();
  next();
});

// Security headers (Helmet)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:',
          'https://res.cloudinary.com',
          'http://localhost:5000', 'http://127.0.0.1:5000',
          'https://api.sosholife.com'],
        mediaSrc: ["'self'", 'blob:',
          'http://localhost:5000', 'http://127.0.0.1:5000',
          'https://api.sosholife.com'],
        scriptSrc: ["'self'",
          'https://www.google.com',
          'https://www.gstatic.com',
          'https://cdn.jsdelivr.net'],
        frameSrc: ["'self'",
          'https://www.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'",
          'ws://localhost:5000', 'ws://127.0.0.1:5000',
          'wss://sosholife.com',
          'http://localhost:5000', 'http://127.0.0.1:5000',
          'https://api.sosholife.com',
          'https://www.google.com'],
      },
    },
  })
);

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.FRONTEND_BASE_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .concat(
    process.env.NODE_ENV !== 'production'
      ? ['http://localhost:3000', 
        'http://localhost:3001', 
        'http://127.0.0.1:3000', 
        'http://127.0.0.1:3001', 
        'http://192.168.1.3:3000', 
        'http://192.168.1.3:3001']
      : []
  );

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🚫 CORS blocked: ${origin}`);
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token', 'user-id'],
  credentials: true,
};

app.options('/{*path}', cors(corsOptions));
app.use(cors(corsOptions));

app.set('trust proxy', 1);
// ── Static uploads — registered BEFORE compression() ─────────────────────────
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    acceptRanges: true,
    lastModified:  true,
    etag:          true,
    maxAge:        '7d',
    immutable:     false,
    fallthrough:   true,
  })
);

// ── Compression — applied AFTER /uploads so static media is never compressed ──
const SKIP_COMPRESSION_RE = /^\/uploads\//;
const COMPRESSIBLE_RE = /^(text|application)\/(javascript|json|html|xml|css|plain)/i;

app.use(
  compression({
    filter: (req, res) => {
      if (SKIP_COMPRESSION_RE.test(req.path)) return false;

      const contentType = res.getHeader('Content-Type') || '';
      if (!COMPRESSIBLE_RE.test(contentType)) return false;

      if (!res.getHeader('Content-Type')) return compression.filter(req, res);
    },

    level: 6,
  })
);

// ── HTTP logging ──────────────────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Cookie parser ─────────────────────────────────────────────────────────────
app.use(cookieParser());

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── HTTPS redirect in production ──────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
console.log('⏳ Connecting to MongoDB...');
mongoose
  .connect(process.env.MONGO_URI, { connectTimeoutMS: 10_000 })
  .then(() => {
    console.log('✅ MongoDB connected');
    require('./jobs/streakReminderJob');
    require('./jobs/subscriptionReminderJob');
  // ── Start Server ──────────────────────────────────────────────────────────────
    server.listen(PORT, () => {
      console.log(`🚀 SoShoLife running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1); // Don't run the app without a DB
  });

// ── Cloudinary ────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Health check (includes DB state) ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const dbStatus = ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown';
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'OK' : 'DEGRADED',
    db: dbStatus,
    uptime: process.uptime(),
  });
});

// API Routes
app.use('/api/auth/createuser', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/admin/adminlogin', authLimiter);
app.use('/api/auth/check-phone', authLimiter);
app.use('/api/auth/reset-password-with-otp', authLimiter);
app.use('/api/auth', require('./routes/auth'));

app.use('/api/otp', otpLimiter, require('./routes/otp'));

const earnedRewardsRouter = require('./routes/earnedRewards');
app.use('/api/auth', earnedRewardsRouter);
app.use('/api/rewards', earnedRewardsRouter);

app.use('/api', (req, res, next) => {
  const url = req.originalUrl;
  if (url.startsWith('/auth/') || url.startsWith('/otp/')) return next();
  return apiLimiter(req, res, next);
});

app.use('/api/posts', require('./routes/posts'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/redeem', require('./routes/redeemGrocery'));
app.use('/api/rewards', require('./routes/userRewardSlabs'));
// Account delete action routes:
app.use('/api/account', require('./routes/accountDeletion'));

//-------------------- Ads routes---------------------
app.use('/api/ads', require('./routes/adsRoutes'));
// ================================================ //

//------------------- Special offer routes -------------------- //
app.use('/api/special-offer', require('./routes/specialOfferRoutes'));
// ================================================ //

// Admin routes — protected at router level with fetchUser + isAdmin middleware
const fetchUserMw = require('./middleware/fetchuser')
const isAdmin = require('./middleware/isAdmin');

// Public admin auth routes (login / createadmin) — no JWT required
app.use('/api/admin', require('./routes/admin'));

// Protected admin sub-router — every route here needs a valid admin JWT
const adminRouter = require('express').Router();
adminRouter.use(fetchUserMw); // 1️⃣ decode JWT → sets req.user
adminRouter.use(isAdmin); // Guard ALL admin sub-routes at the router level
adminRouter.use(require('./routes/adminRewards'));
adminRouter.use(require('./routes/adminRoutes'));
adminRouter.use(require('./routes/adminPostModerationRoutes'));
adminRouter.use(require('./routes/payoutRoutes'));
adminRouter.use(require('./routes/adminActivityReportRoutes'));
adminRouter.use(require('./routes/walletReportRoutes'));

app.use('/api/admin', adminRouter);

// User KYC routes:
app.use('/api/kyc', require('./routes/kycRoutes'));

// Admin KYC routes:
app.use('/api/admin/kyc', require('./routes/adminKycRoutes'));
app.use('/api/admin/kyc-review', require('./routes/adminKycReviewRoutes'));

app.use('/api/upload', require('./routes/upload'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/message', require('./routes/message'));
app.use('/api/status', require('./routes/status'));
app.use('/api', require('./routes/search'));
app.use('/api/push', require('./routes/push'));


// Trust & Safety routes
app.use('/api/trust', require('./routes/trustRoutes'));

// Nightly jobs (after existing cron jobs)
const cron = require('node-cron');
const { runVectorBuilderJob } = require('./jobs/vectorBuilderJob');
const { runGraphAlgorithmsJob } = require('./jobs/graphAlgorithmsJob');
const { runNightlyRescorer } = require('./jobs/nightly_rescorer');

cron.schedule('0 20 * * *', runVectorBuilderJob);    // 02:00 IST
cron.schedule('30 21 * * *', runGraphAlgorithmsJob);  // 03:00 IST
cron.schedule('30 22 * * *', runNightlyRescorer);     // 04:00 IST

const { runCleanup } = require('./scripts/cleanupOrphanData');
cron.schedule('0 1 * * *', () => runCleanup({ dryRun: false })); // 06:30 IST

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // CORS errors
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ message: err.message });
  }
  // Multer errors
  if (err.message?.includes('Only image files are allowed')) {
    return res.status(400).json({ message: 'Only image files are allowed.' });
  }
  if (err.message?.includes('File too large') || err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'File too large.' });
  }
  // Validation errors from express-validator are handled per-route; this is a catch-all
  console.error('💥 Unhandled error:', err);
  res.status(err.status || 500).json({
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong on the server.'
      : err.message,
  });
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error('❌ Forced exit after timeout.');
    process.exit(1);
  }, 10_000);
  forceExit.unref(); 

  server.close(async () => {
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('❌ Error closing MongoDB connection:', err.message);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));