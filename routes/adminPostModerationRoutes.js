// routes/adminPostModerationRoutes.js
//
// All routes here are mounted under /api/admin by index.js inside the
// JWT-guarded adminRouter (fetchUserMw + isAdmin already applied).
//
// Endpoints:
//   GET    /api/admin/posts                — list posts (paginated + filtered)
//   GET    /api/admin/posts/stats          — moderation summary counts
//   PATCH  /api/admin/posts/:id/moderation — approve or reject a post
//   DELETE /api/admin/posts/:id            — hard-delete a post
//   POST   /api/admin/posts/:id/block-user — block the post's author

'use strict';

const express = require('express');
const { param, body, query } = require('express-validator');
const { validationResult } = require('express-validator');
const router  = express.Router();

const ctrl = require('../controllers/adminPostModerationController');

// Inline validation error handler — keeps controllers clean
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// ── GET /posts — list posts ───────────────────────────────────────────────────
router.get(
  '/posts',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('status').optional().isIn(['queued', 'approved', 'rejected']),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('userId').optional().isMongoId(),
  ],
  validate,
  ctrl.listPosts
);

// ── GET /posts/stats — moderation counts ─────────────────────────────────────
// Must be declared BEFORE /posts/:id so Express doesn't treat "stats" as an id
router.get('/posts/stats', ctrl.getStats);

// ── PATCH /posts/:id/moderation — approve or reject ──────────────────────────
router.patch(
  '/posts/:id/moderation',
  [
    param('id').isMongoId().withMessage('Invalid post ID'),
    body('status')
      .isIn(['approved', 'rejected'])
      .withMessage("status must be 'approved' or 'rejected'"),
    body('reason').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  ctrl.moderatePost
);

// ── DELETE /posts/:id — hard delete ──────────────────────────────────────────
router.delete(
  '/posts/:id',
  [param('id').isMongoId().withMessage('Invalid post ID')],
  validate,
  ctrl.deletePost
);

// ── POST /posts/:id/block-user — block the author ────────────────────────────
router.post(
  '/posts/:id/block-user',
  [
    param('id').isMongoId().withMessage('Invalid post ID'),
    body('reason').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  ctrl.blockUser
);

module.exports = router;