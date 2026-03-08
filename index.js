require("dotenv").config({ override: true });

// ⚠️ Jobs are started AFTER the DB connects (see mongoose.connect().then below).
// Removed pre-emptive require() here to avoid scheduling DB queries before
// Mongoose is ready. Models are loaded on-demand by the routes that need them.

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const http = require('http');
const cloudinary = require('cloudinary').v2;
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 5000;

// ✅ Use IOsocket.js as the single entry point for socket initialization
const { initializeSocket, getIO } = require("./sockets/IOsocket");

// Initialize Express
const app = express();
const server = http.createServer(app);

// ==========================================
// SOCKET.IO CONFIGURATION
// ==========================================

// initializeSocket handles Server creation, CORS, middleware, and all handlers internally
initializeSocket(server);

// Make io accessible in routes
app.use((req, res, next) => {
  req.io = getIO();
  next();
});

// ----------------------------------
// ✅ CORS Setup
// ----------------------------------
const ALLOWED_ORIGINS = (process.env.FRONTEND_BASE_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)
  .concat([
    'http://localhost:3001',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'https://sosholife.com',
    'https://www.sosholife.com'
  ]);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🚫 CORS blocked origin: ${origin}`);
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token', 'user-id'],
  credentials: true,
};

// Handle preflight OPTIONS requests for ALL routes before any other middleware
app.options('/{*path}', cors(corsOptions));
app.use(cors(corsOptions));

app.use(cookieParser());

// ----------------------------------
// ✅ Body parser with file size limit
// ----------------------------------
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ----------------------------------
// ✅ Serve /uploads/ as static folder
// ----------------------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------------------
// ✅ MongoDB Connection
// ----------------------------------
console.log('⏳ Attempting MongoDB connection...');
mongoose.connect(process.env.MONGO_URI, {
  connectTimeoutMS: 5000,
})
  .then(() => {
    console.log('✅ MongoDB connected');
    // FIX: Start scheduled jobs AFTER DB connects — they may query the DB on
    // their first tick, so they must not run before Mongoose is ready.
    require('./jobs/streakReminderJob');
    require('./jobs/subscriptionReminderJob');
  })
  .catch(err => console.error('❌ MongoDB error:', err));

// ----------------------------------
// ✅ Cloudinary config
// ----------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dbpsyvmx8',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ----------------------------------
// ✅ Health check route
// ----------------------------------
app.get('/api/health', (req, res) => res.send({ status: 'OK' }));

// ----------------------------------
// ✅ API Routes
// ----------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/otp', require('./routes/otp'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/rewards', require('./routes/userRewardSlabs'));
app.use('/api/auth', require('./routes/earnedRewards'));

// FIX: Merge both admin route files under a single router to avoid
// potential ordering ambiguity when both define overlapping middleware.
const adminRouter = require('express').Router();
adminRouter.use(require('./routes/adminRewards'));
adminRouter.use(require('./routes/adminRoutes'));
app.use('/api/admin', adminRouter);

app.use('/api/upload', require('./routes/upload'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/message', require('./routes/message'));
app.use('/api/status',  require('./routes/status'));

app.use('/api', require('./routes/search'));
app.use('/api/push', require('./routes/push'));

// ----------------------------------
// ✅ Error Handling Middleware
// ----------------------------------
app.use((err, req, res, next) => {
  console.error('💥 Multer or route error:', err.message);
  if (err.message.includes('Only image files are allowed!')) {
    return res.status(400).json({ message: 'Only image files are allowed!' });
  }
  if (err.message.includes('File too large')) {
    return res.status(413).json({ message: 'File size exceeds limit (100MB)' });
  }
  res.status(500).json({ message: 'Something went wrong on the server.' });
});

// ----------------------------------
// ✅ Start Server
// ----------------------------------
server.listen(PORT, () => {
  console.log(`🚀 SoShoLife backend + socket running on http://localhost:${PORT}`);
});