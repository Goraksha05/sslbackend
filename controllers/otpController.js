const Otp = require('../models/Otp');
const User = require('../models/User');
const otpGenerator = require('otp-generator');
const bcrypt = require('bcryptjs');
const fast2sms = require("fast-two-sms");
const VerifiedPhone = require('../models/VerifiedPhone');

// Send OTP
exports.sendOTP = async (req, res) => {
  const { phone } = req.body;

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "User already exists with this phone number." });
    }

    // Generate OTP
    const otpCode = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars: false,
      lowerCaseAlphabets: false,
      numbers: true
    });
    const otpHash = await bcrypt.hash(otpCode, 10);

    console.log(`OTP for ${phone} is: ${otpCode}`);
    // Store OTP hash in DB
    await Otp.findOneAndUpdate(
      { phone },
      { phone, otpHash, createdAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Send SMS via Fast2SMS
    const smsOptions = {
      authorization: process.env.FAST2SMS_API_KEY,
      message: `Your OTP is ${otpCode}`,
      numbers: [phone],
    };

    const smsResponse = await fast2sms.sendMessage(smsOptions);

    res.status(200).json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    console.error('OTP send error:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

// Verify OTP
exports.verifyOTP = async (req, res) => {
  const { phone, otpCode } = req.body;

  if (!phone || !otpCode) {
    return res.status(400).json({ success: false, error: "Phone and OTP are required" });
  }

  try {
    const otpEntry = await Otp.findOne({ phone });
    if (!otpEntry) {
      return res.status(400).json({ success: false, error: "OTP not found or expired" });
    }

    const isMatch = await bcrypt.compare(otpCode, otpEntry.otpHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: "Invalid OTP" });
    }

    await Otp.deleteOne({ phone }); // Clean up
    await VerifiedPhone.findOneAndUpdate(
      { phone },
      { phone, verifiedAt: new Date() },
      { upsert: true }
    );
    res.json({ success: true, message: "OTP verified" });
  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ success: false, error: "OTP verification failed" });
  }
};

exports.sendOTPForPasswordReset = async (req, res) => {
  const { phone } = req.body;

  try {
    // Check user exists
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found with this phone number." });
    }

    // Generate OTP
    const otpCode = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars: false,
      lowerCaseAlphabets: false,
      numbers: true,
    });
    const otpHash = await bcrypt.hash(otpCode, 10);

    console.log(`Reset OTP for ${phone} is: ${otpCode}`);

    await Otp.findOneAndUpdate(
      { phone },
      { phone, otpHash, createdAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Send OTP via SMS
    const smsOptions = {
      authorization: process.env.FAST2SMS_API_KEY,
      message: `Your OTP for password reset is ${otpCode}`,
      numbers: [phone],
    };

    const smsResponse = await fast2sms.sendMessage(smsOptions);

    return res.status(200).json({ success: true, message: "OTP sent for password reset" });
  } catch (err) {
    console.error("OTP send for reset error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
