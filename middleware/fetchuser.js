require('dotenv').config();
var jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET
// const JWT_SECRET = process.env.JWT_SECRET || "$hreeisa$$Busine$$mindedBoy2428";
// const JWT_SECRET = "$hreeisa$$Busine$$mindedBoy2428";

const fetchUser = async (req, res, next) => {
    // console.log("🛂 Incoming request - checking auth token"); //temporary
    // Get token from header
    const authHeader = req.header('Authorization') || req.header('authorization');
    if (!authHeader) {
        return res.status(401).send({ error: "Access denied: Please authenticate using valid token!" });
    }
    // const token = req.header('auth-token');

    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

    // console.log("🛡️ Extracted Token:", token);

    if (!token || token === 'null' || token === 'undefined') {
        console.warn("No usable token found:", token);
        return res.status(401).send({ error: "Access denied: Token missing or invalid!" });
    }

    if (!token || token.split('.').length !== 3) {
        console.warn("❌ Malformed token received:", JSON.stringify(token));
        return next(new Error("Malformed JWT token"));
    }

    try {

        const data = jwt.verify(token, JWT_SECRET);
        // console.log("🔓 JWT verified:", data); //temporary

        const user = await User.findById(data.user.id).select('name email role'); // Add fields as needed

        if (!user) {
            return res.status(401).send({ error: "Access denied: User not found!" });
        }

        req.user = {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            isAdmin: user.role === 'admin'
        };

        // ⏱️ Update lastActive on every API call
        await User.findByIdAndUpdate(data.user.id, { lastActive: Date.now() });

        next();

    } catch (error) {
        console.error("❌ JWT validation failed:", error.message)
        res.status(401).send({ error: "Access denied: Invalid token!" });
    }
}

module.exports = fetchUser