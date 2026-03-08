// routes/status.js
//
// Mount in your main app.js / index.js with:
//   const statusRoutes = require('./routes/status');
//   app.use('/api/status', statusRoutes);
//
// All routes require a valid JWT (fetchUser middleware).

const express          = require('express');
const router           = express.Router();
const fetchUser        = require('../middleware/fetchuser');
const { createUploadMiddleware } = require('../middleware/upload');
const statusController = require('../controllers/statusController');

// Multer instance for status media (images + videos, 50 MB cap)
const uploadStatusMedia = createUploadMiddleware('statusmedia').single('media');

// ── Routes ────────────────────────────────────────────────────────────────────

// POST  /api/status       – create a new status (text or media)
router.post(
  '/',
  fetchUser,
  uploadStatusMedia,      // injects req.file if media is attached
  statusController.createStatus
);

// GET   /api/status/my    – get all of the current user's own statuses
router.get('/my',   fetchUser, statusController.getMyStatuses);

// GET   /api/status/feed  – get statuses from contacts (WhatsApp-style feed)
router.get('/feed', fetchUser, statusController.getStatusFeed);

// GET   /api/status/:statusId          – view a status + mark as seen
router.get('/:statusId',        fetchUser, statusController.viewStatus);

// GET   /api/status/:statusId/views    – owner sees who has viewed (seen-by list)
router.get('/:statusId/views',  fetchUser, statusController.getStatusViews);

// DELETE /api/status/:statusId         – owner deletes a status
router.delete('/:statusId',     fetchUser, statusController.deleteStatus);

module.exports = router;