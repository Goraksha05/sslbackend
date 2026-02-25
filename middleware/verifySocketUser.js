const jwt = require("jsonwebtoken");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "$hreeisa$$Busine$$mindedBoy2428";

const verifySocketUser = async (socket, next) => {
    try {
        let token = socket.handshake.auth?.token;

        if (!token) {
            console.warn("❌ No token provided in socket handshake.");
            return next(new Error("Unauthorized: Token missing"));
        }

        // ✅ Clean the token: remove whitespace, line breaks, etc.
        token = token.trim().replace(/\s/g, '');

        // ✅ Log token safely
        console.log("🛡️ Cleaned Token:", JSON.stringify(token));

        // ✅ Validate token format
        if (token.split('.').length !== 3) {
            console.error("❌ Malformed token structure:", JSON.stringify(token));
            return next(new Error("Unauthorized: Malformed token"));
        }

        // ✅ Verify and decode token
        const decoded = jwt.verify(token, JWT_SECRET);

        const userId = decoded.user?.id;
        if (!userId) {
            return next(new Error("Unauthorized: Invalid token payload"));
        }

        const user = await User.findById(userId).select("-password");
        if (!user) {
            return next(new Error("Unauthorized: User not found"));
        }

        // Attach user to socket
        socket.user = user;
        next();

    } catch (error) {
        console.error("❌ Socket auth failed:", error.message);
        return next(new Error("Unauthorized: Invalid or expired token"));
    }
};

module.exports = verifySocketUser;