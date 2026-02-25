require('dotenv').config();
const User = require('../models/User');
const Otp = require('../models/Otp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "$hreeisa$$Busine$$mindedBoy2428";

/**
 * @route   POST /api/auth/createuser
 * @desc    Register a new user after OTP verification
 * @access  Public
 */
exports.signup = async (req, res) => {
  try {
    const { name, username, email, phone, password } = req.body;

    // Validate required fields
    if (!name || !username || !email || !phone || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    // Check OTP verification
    const otpRecord = await Otp.findOne({ phone });
    if (!otpRecord || !otpRecord.verified) {
      return res.status(403).json({ success: false, error: 'Phone number not verified via OTP' });
    }

    // Check for existing user by email, phone, or username
    const existingUser = await User.findOne({
      $or: [
        { email },
        { phone },
        { username }
      ]
    });
    if (existingUser) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Referral constraints similar to createUser()
    const totalUsers = await User.countDocuments();
    let referrer = null;
    if (totalUsers > 0) {
      if (!referralno) {
        return res.status(400).json({ success: false, error: 'Referral ID required' });
      }
      referrer = await User.findOne({ referralId: String(referralno).trim().toUpperCase() });
      if (!referrer) {
        return res.status(400).json({ success: false, error: 'Invalid referral ID' });
      }
    }

    // Create new user
    const user = await User.create({
      name,
      username,
      email,
      phone,
      password: hashedPassword,
      referral: referrer ? referrer._id : null
    });

    // Cleanup OTP record
    await Otp.deleteOne({ phone });

    // Generate JWT token
    const payload = { user: { id: user._id, username: user.username, name: user.name } };
    const authtoken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    // Respond with token
    res.status(201).json({
      success: true,
      authtoken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        referralId: user.referralId // ✅ send public referral code
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};
