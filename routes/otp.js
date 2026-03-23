const express = require('express');
const router = express.Router();
const otpController = require('../controllers/otpController');

router.post('/send', otpController.sendOTP);
router.post('/verify', otpController.verifyOTP);
router.post('/send-for-reset', otpController.sendOTPForPasswordReset);


module.exports = router;