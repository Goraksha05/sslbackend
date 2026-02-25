const express = require('express');
const router = express.Router();
const otpController = require('../controllers/otpController');

router.post('/send', otpController.sendOTP);
router.post('/verify', otpController.verifyOTP);


// 👇 Development/test-only route: simulate sending OTP with inbuilt JSON
router.post('/otp/send', async (req, res) => {
    req.body = {
      phone: '7249157446' // 👈 change to your test number
    };
    return otpController.sendOTP(req, res);
  });
  // 👇 Development/test-only route: simulate verifying OTP with inbuilt JSON
  router.post('/otp/verify', async (req, res) => {
    req.body = {
      phone: '7249157446',   // 👈 use the same phone
      otpCode: '654321'      // 👈 set the test OTP manually
    };
    return otpController.verifyOTP(req, res);
  });

  router.post('/send-for-reset', otpController.sendOTPForPasswordReset);


module.exports = router;
