const { validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Activity = require('../models/Activity');
const Profile = require('../models/Profile');
// const VerifiedPhone = require('../schema_models/VerifiedPhone');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const Notification = require('../models/Notification');
const Friendship = require('../models/Friendship');
const { getIO } = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser = require('../utils/notifyUser');

const JWT_SECRET = process.env.JWT_SECRET;
// const JWT_SECRET = process.env.JWT_SECRET || "$hreeisa$$Busine$$mindedBoy2428";
// const JWT_SECRET = "$hreeisa$$Busine$$mindedBoy2428";

// Register new user

exports.createUser = async (req, res) => {

  // console.log("Request body received on /createuser:", req.body);

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });


  const { name, username, email, phone, password, referralno, role } = req.body;
  const userRole = role === 'admin' ? 'admin' : 'user';
  const phonenumber = req.body.phone;

  if (!name || !username || !email || !phone || !password) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  // Allow first user to register without referral
  let referrer = null;
  const totalUsers = await User.countDocuments();
  if (totalUsers === 0) {
    console.log("No users found. Creating the first user without referral.");
  } else {
    if (!referralno) {
      return res.status(400).json({ message: 'Referral code required. Please ask your friend to share their ID.' });
    }

    //   referrer = await User.findById(referralno);
    //   if (!referrer) {
    //     return res.status(400).json({ message: 'Invalid referral code. Please ask your friend to share their ID.' });
    //   }
    // }

    // ✅ Find by referralId (e.g., "DU688828"), not by Mongo _id
    referrer = await User.findOne({ referralId: String(referralno).trim().toUpperCase() });
    if (!referrer) {
      return res.status(400).json({ message: 'Invalid referral ID. Please ask your friend to share their correct ID.' });
    }
  }

  // Check if referralCode exists and is a valid user ID
  // const referrer = await User.findById(referralno);
  // if (!referrer) {
  //   return res.status(400).json({ message: 'Invalid referral code. Please ask your friend to share their ID.' });
  // }

  // const verified = await VerifiedPhone.findOne({ phone });
  // if (!verified) {
  //   return res.status(400).json({ error: "Phone number not verified. Please verify with OTP." });
  // }

  try {
    let existingUser = await User.findOne({ $or: [{ email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({ error: "User with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({
      name,
      username,
      email,
      phone,
      password: hashedPassword,
      referral: referrer ? referrer._id : null,
      role: userRole,
      isAdmin: false
    });

    await newUser.save();

    await Profile.create({
      user_id: newUser._id,
      followers: [],
      following: []
    });

    if (referrer) {
      await Activity.create({ user: newUser._id, referral: referrer._id });
    }

    if (referrer) {
      // ✅ DB Notification
      await Notification.create({
        user: referrer._id,
        sender: newUser._id,
        type: 'referral_signup',
        message: `${newUser.name} joined using your referral code! 🎉`,
        url: `/profile/${newUser._id}`
      });

      // ✅ Toast notification
      await notifyUser(referrer._id, `${newUser.name} joined using your referral code! 🎉`, 'referral_signup');

      // ✅ Push Notification
      sendPushToUser(referrer._id.toString(), {
        title: 'New Referral Signup',
        message: `${newUser.name} just created an account with your referral!`,
        url: `/profile/${newUser._id}`
      });

      // ✅ Socket emit
      const io = getIO();
      io.to(referrer._id.toString()).emit('notification', {
        type: 'referral_signup',
        from: newUser._id,
        message: `${newUser.name} joined using your referral code! 🎉`
      });
    }

    // Track referral activity
    // await Activity.create({ referral: referrer._id });

    // ✅ AUTO-FRIENDSHIP CREATION
    try {
      const existingFriendship = await Friendship.findOne({
        $or: [
          { requester: referrer._id, recipient: newUser._id },
          { requester: newUser._id, recipient: referrer._id }
        ]
      });

      if (!existingFriendship) {
        await Friendship.create({
          requester: referrer._id,
          recipient: newUser._id,
          status: 'accepted'
        });

        console.log(`🤝 Auto-friendship created between ${referrer._id} and ${newUser._id}`);

        // Notify both users about auto-friendship
        const io = getIO();
        
        io.to(referrer._id.toString()).emit('notification', {
          type: 'friend_accept',
          from: newUser._id,
          message: `${newUser.name} is now your friend (via referral)!`
        });
        io.to(newUser._id.toString()).emit('notification', {
          type: 'friend_accept',
          from: referrer._id,
          message: `You are now friends with ${referrer.name}!`
        });
      }
    } catch (err) {
      console.error("❌ Failed to auto-create friendship:", err.message);
    }

    const payload = {
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        role: newUser.role
      }
    };
    const authtoken = jwt.sign(payload, JWT_SECRET);

    try {
      if (referrer) {
        await fetch('http://localhost:5000/api/activity/referral', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwt.sign({ user: { id: newUser._id.toString() } }, JWT_SECRET)}`
          },
          body: JSON.stringify({
            referralNumber: referrer._id.toString(),
            referrerCode: referrer.referralId,
            newUserId: newUser._id.toString()
          })
        });
      }
    } catch (err) {
      console.error("Failed to log referral activity automatically:", err.message);
    }

    res.status(201).json({
      success: true,
      authtoken: authtoken.trim().replace(/\s/g, ''),
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        username: newUser.username,
        isAdmin: newUser.isAdmin,
        subscription: newUser.subscription,
        // ✅ expose the public referralId to the client
        referralId: newUser.referralId
      },
      message: 'Account created successfully'
    });

    // After creating newUser, Activity, and before sending the final response:
    if (referrer) {
      try {
        const referredCount = await User.countDocuments({ referral: referrer._id });

        // Activate via referrals if target reached and not already active by paid
        const target = referrer.subscription?.referralTarget ?? 10;
        const alreadyActive = !!referrer.subscription?.active;

        if (referredCount >= target && !alreadyActive) {
          const now = new Date();
          const oneYearLater = new Date(now);
          oneYearLater.setFullYear(now.getFullYear() + 1);

          await User.findByIdAndUpdate(referrer._id, {
            $set: {
              subscription: {
                ...referrer.subscription?.toObject?.() || referrer.subscription || {},
                plan: referrer.subscription?.plan || 'Referral',
                active: true,
                startDate: now,
                expiresAt: oneYearLater,
                autoRenew: false,
                activationMethod: 'referrals',
                referralActivatedAt: now,
                referralTarget: target
              }
            }
          });
          console.log(`🎉 Referral activation: ${referrer._id} now active via referrals`);
        }
      } catch (e) {
        console.error('Referral activation check failed:', e.message);
      }
    }

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ success: false, message: 'Create User - Internal Server Error' }); // FIXED
  }

};

// Login existing user
exports.loginUser = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { identifier, password, role } = req.body;

  try {
    let user = null;

    // Determine identifier type
    if (/^\S+@\S+\.\S+$/.test(identifier)) {
      user = await User.findOne({ email: identifier });
    } else if (/^\d{10}$/.test(identifier)) {
      user = await User.findOne({ phone: identifier });
    } else {
      user = await User.findOne({ username: identifier });
    }

    // Check if user was found
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // ✅ NOW check the role against actual user
    // if (role && user.role && user.role !== role) {
    if (role && user.role !== role) {
      return res.status(403).json({ error: 'Role mismatch. Access denied.' });
    }

    // Validate password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect password' });
    }

    // ✅ Update lastActive before issuing token
    user.lastActive = new Date();
    await user.save()

    // Generate token
    const payload = {
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role
      }
    };
    const authtoken = jwt.sign(payload, JWT_SECRET);

    // ✅ Create notification in DB
    const loginNote = await Notification.create({
      user: user._id,
      type: 'custom', // we can add "login_success" later if you want a dedicated type
      message: `Welcome back, ${user.name}! You logged in successfully.`,
      url: '/dashboard'
    });

    // ✅ Push toast notification
    // await notifyUser(
    //   user._id,
    //   `Welcome back, ${user.name}! You logged in successfully.`,
    //   'custom'
    // );

    // ✅ Push notification to device
    sendPushToUser(user._id.toString(), {
      title: 'Login Successful 🎉',
      message: `Welcome back, ${user.name}!`,
      url: '/dashboard'
    });

    // ✅ Socket emit
    const io = getIO();
    io.to(user._id.toString()).emit('notification', loginNote);

    res.json({
      success: true,
      authtoken: authtoken.trim().replace(/\s/g, ''),
      user: {
        id: user._id,
        role: user.role,
        referral: user.referral,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        isAdmin: user.isAdmin,
        subscription: user.subscription,
        referralId: user.referralId,
        lastActive: user.lastActive
      }
    });
  } catch (error) {
    console.error("Login - Internal Server Error:", error.stack);
    res.status(500).json({ success: false, message: "Login - Internal Server Error" });
  }
};

// Verify if phone is registered
exports.checkPhoneExists = async (phone) => {
  if (!/^\d{10}$/.test(phone)) {
    return { success: false, message: "Enter a valid 10-digit number" };
  }

  try {
    const res = await fetch("http://localhost:5000/api/auth/check-phone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });

    if (res.status === 404) {
      return { success: false, message: "Phone check endpoint not found. Check backend routing." };
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("Phone check error:", err);
    return { success: false, message: "Server error while verifying phone." };
  }
};

// ✅ Add this at bottom of authController.js
exports.resetPasswordWithOtp = async (req, res) => {
  const { phone, otp, newPassword } = req.body;

  if (!/^\d{10}$/.test(phone) || !otp || newPassword.length < 5) {
    return res.status(400).json({ success: false, message: "Invalid input." });
  }

  try {
    // const verified = await VerifiedPhone.findOne({ phone });
    // if (!verified) {
    //   return res.status(400).json({ success: false, message: "Phone not verified." });
    // }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return res.json({ success: true, message: "Password reset successful." });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ✅ GET /api/users/referred — fetch all users referred by this user
exports.getReferredUsers = async (req, res) => {
  const userId = req.user.id;

  try {
    const referredUsers = await User.find({ referral: userId }).select(
      'name username email phone subscription active'
    );
    res.status(200).json({ referredUsers });
  } catch (err) {
    console.error('Error fetching referred users:', err.message);
    res.status(500).json({ message: 'Server error fetching referred users' });
  }
};

// ✅ Get user by ID
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      success: true,
      user: {
        id: user._id,
        role: user.role,
        referral: user.referral,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        isAdmin: user.isAdmin,
        subscription: user.subscription,
        referralId: user.referralId
      }
    });

  } catch (error) {
    console.error("Get User By ID Error:", error.message);
    res.status(500).json({ error: "Failed to fetch user details" });
  }
};

exports.acceptTerms = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ error: 'User not found' });

    user.termsAccepted = true;
    await user.save();

    res.status(200).json({ success: true, message: 'Terms accepted' });
  } catch (err) {
    console.error('Error updating terms acceptance:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};