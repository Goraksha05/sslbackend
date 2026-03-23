// routes/search.js
//
// FIX: The search query was passed directly to MongoDB as a regex:
//   { name: { $regex: query, $options: 'i' } }
// where `query` came from req.query.query with only a .trim() applied.
//
// This allows ReDoS (Regular Expression Denial of Service) attacks. A request
// with a pathological pattern like `a+a+a+a+a+a+a+a+a+a+a+a+$` causes
// catastrophic backtracking in MongoDB's regex engine, blocking the thread for
// seconds or minutes per request and making the endpoint trivially DDoS-able.
//
// Fix: escape all regex metacharacters in the user-supplied string before
// passing it to the query. The escaped string matches only literal characters,
// so the query is safe to use as a case-insensitive substring search.

'use strict';

const express   = require('express');
const router    = express.Router();
const fetchUser = require('../middleware/fetchuser');
const User      = require('../models/User');
const Profile   = require('../models/Profile');

/**
 * Escape all regex metacharacters in a string so it can be used safely
 * as a literal substring pattern inside a MongoDB $regex query.
 *
 * Escapes: \ ^ $ . | ? * + ( ) [ ] { }
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/users/search?query=...
router.get('/users/search', fetchUser, async (req, res) => {
  try {
    const raw = req.query.query?.trim();
    if (!raw) return res.json([]);

    // FIX: escape before using as regex — prevents ReDoS
    const safe = escapeRegex(raw);

    const users = await User.aggregate([
      {
        $match: {
          $or: [
            { name:     { $regex: safe, $options: 'i' } },
            { username: { $regex: safe, $options: 'i' } },
          ],
        },
      },
      {
        $lookup: {
          from:         'profiles',
          localField:   '_id',
          foreignField: 'user_id',
          as:           'profile',
        },
      },
      { $unwind: { path: '$profile', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id:          1,
          name:         1,
          username:     1,
          profileImage: { $ifNull: ['$profile.profileavatar.URL', ''] },
          currentcity:  '$profile.currentcity',
          hometown:     '$profile.hometown',
          sex:          '$profile.sex',
          relationship: '$profile.relationship',
        },
      },
      { $limit: 10 },
    ]);

    return res.json(users);
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;