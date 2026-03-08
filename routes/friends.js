// routes/friends.js
//
// Thin route file — all logic lives in friendController.js
//
// Endpoints:
//   POST   /friend-request/:recipientId          Send a request
//   PUT    /friend-request/:id/accept            Accept
//   PUT    /friend-request/:id/decline           Decline
//   DELETE /friend-request/:id/cancel            Cancel outgoing
//   DELETE /unfriend/:friendId                   Unfriend
//   POST   /block/:targetId                      Block
//   DELETE /block/:targetId                      Unblock
//   GET    /all                                  All friends (+ ?search=)
//   GET    /requests                             Incoming requests
//   GET    /requests/sent            NEW         Outgoing requests
//   GET    /suggestions              IMPROVED    Smart suggestions
//   GET    /mutual/:targetId         NEW         Mutual friends
//   GET    /status/:targetId                     Friendship status
//   GET    /count/:userId            NEW         Public friend count

const express  = require('express');
const router   = express.Router();
const fetchUser = require('../middleware/fetchuser');
const ctrl     = require('../controllers/friendController');

// ── Auth-required routes ───────────────────────────────────────────────────
router.post  ('/friend-request/:recipientId',    fetchUser, ctrl.sendRequest);
router.put   ('/friend-request/:id/accept',      fetchUser, ctrl.acceptRequest);
router.put   ('/friend-request/:id/decline',     fetchUser, ctrl.declineRequest);
router.delete('/friend-request/:id/cancel',      fetchUser, ctrl.cancelRequest);
router.delete('/unfriend/:friendId',             fetchUser, ctrl.unfriend);

router.post  ('/block/:targetId',                fetchUser, ctrl.blockUser);
router.delete('/block/:targetId',                fetchUser, ctrl.unblockUser);

router.get   ('/all',                            fetchUser, ctrl.getAllFriends);
router.get   ('/requests',                       fetchUser, ctrl.getRequests);
router.get   ('/requests/sent',                  fetchUser, ctrl.getSentRequests);   // NEW
router.get   ('/suggestions',                    fetchUser, ctrl.getSuggestions);
router.get   ('/mutual/:targetId',               fetchUser, ctrl.getMutualFriends);  // NEW
router.get   ('/status/:targetId',               fetchUser, ctrl.getStatus);
router.get   ('/count/:userId',                  fetchUser, ctrl.getFriendCount);    // NEW

module.exports = router;