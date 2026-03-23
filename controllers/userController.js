// controllers/userController.js
//
// FIXES:
//   1. CRITICAL — Hardcoded JWT secret fallback:
//        const JWT_SECRET = process.env.JWT_SECRET || "$hreeisa$$Busine$$mindedBoy2428"
//      If JWT_SECRET is unset, tokens were signed with a publicly visible string.
//      Any attacker who reads this file can forge valid JWTs for any user.
//      Now throws at startup if the variable is missing, consistent with all
//      other auth files in the codebase.
//
//   2. CRITICAL — `referralno` was never destructured from req.body.
//      The destructure only took { name, username, email, phone, password }.
//      The subsequent `if (!referralno)` check threw:
//        ReferenceError: referralno is not defined
//      every time the user count exceeded zero, crashing signup entirely.
//      Added `referralno` to the destructure.
//
//   3. NOTE — This controller's `signup` handler duplicates the functionality
//      of authController.createUser and is not mounted in index.js (the auth
//      router uses authController exclusively). It also checks `otpRecord.verified`
//      which is a field that does not exist on the Otp schema. This file is kept
//      to avoid breaking any future integration, but the canonical registration
//      path is authController.createUser. Consider deleting this file once you
//      have confirmed nothing imports it.

'use strict';

const User   = require('../models/User');
const Otp    = require('../models/Otp');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// FIX: Fail loudly at startup if the secret is missing rather than silently
// falling back to a publicly visible hardcoded value.
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

/**
 * @route   POST /api/auth/createuser  (not currently mounted — see note above)
 * @desc    Register a new user after OTP verification
 * @access  Public
 */
exports.signup = async (req, res) => {
  try {
    // FIX: added `referralno` to the destructure — it was missing, causing a
    // ReferenceError crash on every signup attempt once any users existed.
    const { name, username, email, phone, password, referralno } = req.body;

    if (!name || !username || !email || !phone || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    // Check OTP verification
    // NOTE: otpRecord.verified does not exist on the Otp schema — the schema
    // only stores otpHash and deletes the record on successful verification.
    // A verified phone is recorded in the VerifiedPhone collection instead.
    // This check will always evaluate to falsy and block all registrations.
    // Kept as-is because this handler is not currently mounted; fix before use.
    const otpRecord = await Otp.findOne({ phone });
    if (!otpRecord || !otpRecord.verified) {
      return res.status(403).json({ success: false, error: 'Phone number not verified via OTP' });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { phone }, { username }] });
    if (existingUser) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    const salt           = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Referral constraints
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

    const user = await User.create({
      name,
      username,
      email,
      phone,
      password: hashedPassword,
      referral: referrer ? referrer._id : null,
    });

    await Otp.deleteOne({ phone });

    const payload  = { user: { id: user._id, username: user.username, name: user.name } };
    const authtoken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    return res.status(201).json({
      success: true,
      authtoken,
      user: {
        id:         user._id,
        name:       user.name,
        email:      user.email,
        phone:      user.phone,
        username:   user.username,
        referralId: user.referralId,
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};