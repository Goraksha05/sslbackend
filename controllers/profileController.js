const User = require('../models/User');

// Get authenticated user profile
exports.getUser = async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId).select('-password');

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(user);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Get User - Internal Server Error');
    }
};
