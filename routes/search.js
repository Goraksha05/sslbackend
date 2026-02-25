// backend/routes/search.js
const express = require('express');
const router = express.Router();
const fetchUser = require('../middleware/fetchuser');
const User = require('../models/User');
const Profile = require('../models/Profile');

// Search route
router.get('/users/search', fetchUser, async (req, res) => {
    try {
        const query = req.query.query?.trim();
        if (!query) return res.json([]);

        const users = await User.aggregate([
            {
                $match: {
                    $or: [
                        { name: { $regex: query, $options: 'i' } },
                        { username: { $regex: query, $options: 'i' } }
                    ]
                }
            },
            {
                $lookup: {
                    from: 'profiles',
                    localField: '_id',
                    foreignField: 'user_id',
                    as: 'profile'
                }
            },
            { $unwind: { path: '$profile', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 1,
                    name: 1,
                    username: 1,
                    profileImage: { $ifNull: ['$profile.profileavatar.URL', ''] },
                    currentcity: '$profile.currentcity',
                    hometown: '$profile.hometown',
                    sex: '$profile.sex',
                    relationship: '$profile.relationship'
                }
            },
            { $limit: 10 }
        ]);

        res.json(users);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
