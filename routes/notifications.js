// notifications.js
const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const User = require('../models/User');
const fetchUser = require("../middleware/fetchuser");

// ------------------------------------
// GET paginated notifications
// ------------------------------------
router.get("/", fetchUser, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ user: req.user.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "user", model: "user", select: "name username" })
        .populate({ path: "sender", model: "user", select: "name profileavatar username" }),
      Notification.countDocuments({ user: req.user.id }),
      Notification.countDocuments({ user: req.user.id, isRead: false }),
    ]);

    res.status(200).json({
      status: "success",
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      count: notifications.length,
      unreadCount,
      data: notifications,
    });
  } catch (error) {
    console.error("[FETCH NOTIFICATIONS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: "Could not fetch notifications.",
    });
  }
});

// ------------------------------------
// Mark all notifications as read
// ------------------------------------
router.put("/mark-all-read", fetchUser, async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, isRead: false },
      { $set: { isRead: true } }
    );

    return res.status(200).json({
      status: "success",
      message: "All notifications marked as read.",
    });
  } catch (error) {
    console.error(`[MARK ALL READ ERROR] ${error.message}`);
    return res.status(500).json({
      status: "error",
      message: "Could not mark notifications as read.",
    });
  }
});

// ------------------------------------
// Mark single notification as read
// ------------------------------------
router.put("/:id/read", fetchUser, async (req, res) => {
  try {
    const note = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: { isRead: true } },
      { new: true }
    );

    if (!note) {
      return res
        .status(404)
        .json({ status: "error", message: "Notification not found" });
    }

    return res.status(200).json({
      status: "success",
      message: "Notification marked as read.",
    });
  } catch (error) {
    console.error(`[MARK ONE READ ERROR] ${error.message}`);
    return res.status(500).json({
      status: "error",
      message: "Could not mark notification as read.",
    });
  }
});

// ------------------------------------
// Get unread count
// ------------------------------------
router.get("/unread-count", fetchUser, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      user: req.user.id,
      isRead: false,
    });

    return res.status(200).json({ status: "success", unreadCount: count });
  } catch (error) {
    console.error(`[UNREAD COUNT ERROR] ${error.message}`);
    return res.status(500).json({
      status: "error",
      message: "Could not fetch unread notification count.",
    });
  }
});

// ------------------------------------
// Delete old notifications (default 30 days)
// Accept both DELETE and POST for compatibility with some clients/proxies
// ------------------------------------
async function cleanupHandler(req, res) {
  const daysOld = 30; // configurable
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

  try {
    const result = await Notification.deleteMany({
      user: req.user.id,
      createdAt: { $lt: cutoffDate },
    });

    return res.status(200).json({
      status: "success",
      deletedCount: result.deletedCount,
      message: `Deleted ${result.deletedCount} old notifications.`,
    });
  } catch (error) {
    console.error(`[DELETE OLD NOTIFICATIONS ERROR] ${error.message}`);
    return res.status(500).json({
      status: "error",
      message: "Could not delete old notifications.",
    });
  }
}

router.delete("/cleanup", fetchUser, cleanupHandler);
// fallback POST for clients that cannot send DELETE due to infrastructure
router.post("/cleanup", fetchUser, cleanupHandler);

module.exports = router;
