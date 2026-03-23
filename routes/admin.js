const express = require('express');
const { body } = require('express-validator');
const fetchUser = require('../middleware/fetchuser');
const captchaMiddleware = require("../middleware/captcha");
const adminAuthController = require('../controllers/adminAuthController');
const User = require('../models/User');

const router = express.Router();

// Admin Auth Routes
router.post('/createadmin',
   captchaMiddleware,
  [
    body('name').isLength({ min: 3 }),
    body('username').isLength({ min: 3 }).custom(value => !/\s/.test(value)),
    body('email').isEmail(),
    body('phone').isLength({ min: 10, max: 10 }).matches(/^\d+$/),
    body('password').isLength({ min: 5 })
  ], adminAuthController.createAdmin);


router.post('/adminlogin',
   captchaMiddleware,
  [
    body('identifier').notEmpty(),
    body('password').exists()
  ], adminAuthController.loginAdmin);


// Get user info by ID
router.get('/getloggeduser/:id', fetchUser, adminAuthController.getUserById);
