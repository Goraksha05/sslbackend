require('dotenv').config({ quiet: true });
require('./jobs/streakReminderJob');
require('./jobs/subscriptionReminderJob');
require("./models/User");
require("./models/Notification");

// const connectToMongo = require ('./database');
const express = require('express')
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const http = require('http');
const cloudinary = require('cloudinary').v2;
const cookieParser = require('cookie-parser');

// connectToMongo();
// copy this boilerPlate from express.js website
const app = express()
const PORT = process.env.PORT || 5001;

// ----------------------------------
// ✅ CORS Setup
// ----------------------------------
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://sosholife.com',
    'https://www.sosholife.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

app.use(cookieParser());

// ----------------------------------
// ✅ Body parser with file size limit
// ----------------------------------
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ----------------------------------
// ✅ Serve /uploads/ as static folder
//     This makes /uploads/profiles/ accessible
// ----------------------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------------------
// ✅ MongoDB Connection
// ----------------------------------
console.log('⏳ Attempting MongoDB connection...');
mongoose.connect(process.env.MONGO_URI, {
  connectTimeoutMS: 5000, // force error after 5 seconds if not connected
})
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ----------------------------------
// ✅ Cloudinary config (optional: only if needed)
// ----------------------------------
cloudinary.config({
  cloud_name: 'dbpsyvmx8',
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

app.use('/api/admin', require('./routes/adminRewards'));
app.use('/api/admin', require('./routes/adminRoutes'));

app.use('/api/upload', require('./routes/upload'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/message', require('./routes/message'));

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
// ✅ Socket.IO Init
// ----------------------------------
const server = http.createServer(app);
const { initializeSocket } = require('./sockets/IOsocket');
initializeSocket(server);

// ----------------------------------
// ✅ Start Server
// ----------------------------------
server.listen(PORT, () => {
  console.log(`🚀 SoShoLife backend + socket running on http://localhost:${PORT}`);
});