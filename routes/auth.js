const express = require('express');
const { body } = require('express-validator');
const fetchUser = require('../middleware/fetchuser');
const authController = require('../controllers/authController');
// const adminAuthController = require('../controllers/adminAuthController');
//const captchaMiddleware = require("../middleware/captcha");
const profileController = require('../controllers/profileController');
const User = require('../models/User');

const router = express.Router();

// Auth Routes
router.post('/createuser',
  //  captchaMiddleware,
  [
    body('name').isLength({ min: 3 }),
    body('username').isLength({ min: 3 }).custom(value => !/\s/.test(value)),
    body('email').isEmail(),
    body('phone').isLength({ min: 10, max: 10 }).matches(/^\d+$/),
    body('password').isLength({ min: 5 })
  ], authController.createUser);


router.post('/login',
  //  captchaMiddleware,
  [
    body('identifier').notEmpty(),
    body('password').exists()
  ], authController.loginUser);


// Admin Auth Routes
// router.post('/createadmin',
  //  captchaMiddleware,
  // [
  //   body('name').isLength({ min: 3 }),
  //   body('username').isLength({ min: 3 }).custom(value => !/\s/.test(value)),
  //   body('email').isEmail(),
  //   body('phone').isLength({ min: 10, max: 10 }).matches(/^\d+$/),
  //   body('password').isLength({ min: 5 })
  // ], adminAuthController.createAdmin);

// router.post('/adminlogin',
  //  captchaMiddleware,
  // [
  //   body('identifier').notEmpty(),
  //   body('password').exists()
  // ], adminAuthController.loginAdmin);

// Profile Route
router.get('/getuser/:id', fetchUser, profileController.getUser);

// Get user info by ID
router.get('/getloggeduser/:id', fetchUser, authController.getUserById);

// ✅ Add this new route for referrals
router.get('/users/referred', fetchUser, authController.getReferredUsers);

// router.post('/refresh-token', authController.refreshToken);

//Verify Existing phone number for Forgot Password
router.post('/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;

    // ✅ Validate phone format
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number format. Must be 10 digits.",
      });
    }

    // ✅ Look up user by phone
    const user = await User.findOne({ phone: String(phone) });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Phone number not registered.",
      });
    }

    // ✅ Success
    return res.status(200).json({
      success: true,
      message: "Phone number verified.",
    });

  } catch (err) {
    console.error("❌ check-phone error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error. Please try again later.",
    });
  }
});

router.post('/reset-password-with-otp', authController.resetPasswordWithOtp);

router.post('/accept-terms', fetchUser, authController.acceptTerms);

module.exports = router;
