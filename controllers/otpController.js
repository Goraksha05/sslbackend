// controllers/otpController.js
//
// FIX: Removed console.log() calls that printed OTP codes in plaintext:
//   console.log(`OTP for ${phone} is: ${otpCode}`)
//   console.log(`Reset OTP for ${phone} is: ${otpCode}`)
// In any managed hosting environment with log aggregation (Datadog, CloudWatch,
// Render logs), these codes appeared in plain text and were accessible to anyone
// with log read access — effectively bypassing OTP security entirely.
// Replaced with a sanitised log that records only that an OTP was sent, not its value.

'use strict';

const Otp          = require('../models/Otp');
const User         = require('../models/User');
const otpGenerator = require('otp-generator');
const bcrypt       = require('bcryptjs');
const fast2sms     = require('fast-two-sms');
const VerifiedPhone = require('../models/VerifiedPhone');

// ── Send OTP (registration) ───────────────────────────────────────────────────
exports.sendOTP = async (req, res) => {
  const { phone } = req.body;

  try {
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists with this phone number.' });
    }

    const otpCode = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars:       false,
      lowerCaseAlphabets: false,
      numbers:            true,
    });
    const otpHash = await bcrypt.hash(otpCode, 10);

    // FIX: Never log the OTP value. Log only the event so you can trace delivery issues.
    console.log(`[otpController] OTP dispatched to ${phone.replace(/\d(?=\d{4})/g, '*')}`);

    await Otp.findOneAndUpdate(
      { phone },
      { phone, otpHash, createdAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const smsOptions = {
      authorization: process.env.FAST2SMS_API_KEY,
      message:       `Your OTP is ${otpCode}`,
      numbers:       [phone],
    };

    await fast2sms.sendMessage(smsOptions);

    return res.status(200).json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    console.error('OTP send error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

// ── Verify OTP ────────────────────────────────────────────────────────────────
exports.verifyOTP = async (req, res) => {
  const { phone, otpCode } = req.body;

  if (!phone || !otpCode) {
    return res.status(400).json({ success: false, error: 'Phone and OTP are required' });
  }

  try {
    const otpEntry = await Otp.findOne({ phone });
    if (!otpEntry) {
      return res.status(400).json({ success: false, error: 'OTP not found or expired' });
    }

    const isMatch = await bcrypt.compare(otpCode, otpEntry.otpHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }

    await Otp.deleteOne({ phone });
    await VerifiedPhone.findOneAndUpdate(
      { phone },
      { phone, verifiedAt: new Date() },
      { upsert: true }
    );

    return res.json({ success: true, message: 'OTP verified' });
  } catch (err) {
    console.error('OTP verification error:', err);
    return res.status(500).json({ success: false, error: 'OTP verification failed' });
  }
};

// ── Send OTP (password reset) ─────────────────────────────────────────────────
exports.sendOTPForPasswordReset = async (req, res) => {
  const { phone } = req.body;

  try {
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found with this phone number.' });
    }

    const otpCode = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars:       false,
      lowerCaseAlphabets: false,
      numbers:            true,
    });
    const otpHash = await bcrypt.hash(otpCode, 10);

    // FIX: log only the masked phone, never the OTP value
    console.log(`[otpController] Reset OTP dispatched to ${phone.replace(/\d(?=\d{4})/g, '*')}`);

    await Otp.findOneAndUpdate(
      { phone },
      { phone, otpHash, createdAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const smsOptions = {
      authorization: process.env.FAST2SMS_API_KEY,
      message:       `Your OTP for password reset is ${otpCode}`,
      numbers:       [phone],
    };

    await fast2sms.sendMessage(smsOptions);

    return res.status(200).json({ success: true, message: 'OTP sent for password reset' });
  } catch (err) {
    console.error('OTP send for reset error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};