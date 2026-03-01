const { validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Activity = require('../models/Activity');
const Profile = require('../models/Profile');
const Notification = require('../models/Notification');
const Friendship = require('../models/Friendship');
const { getIO } = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser = require('../utils/notifyUser');

// ── Constants ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// FIX: Removed hardcoded fallback secret — if JWT_SECRET is missing the app
// should fail loudly at startup, not silently use an insecure default.
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

// ── Helper: sign token ────────────────────────────────────────────────────────
function signToken(payload) {
  // FIX: Always set an expiry on JWTs. The original code called jwt.sign()
  // without `expiresIn`, meaning tokens NEVER expired — a serious security hole.
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// ── Helper: safe referral activation (extracted for reuse) ─────────────────
async function checkReferralActivation(referrer) {
  try {
    const referredCount = await User.countDocuments({ referral: referrer._id });
    const target = referrer.referralTarget ?? 10;
    const alreadyActive = !!referrer.subscription?.active;

    if (referredCount >= target && !alreadyActive) {
      const now = new Date();
      const oneYearLater = new Date(now);
      oneYearLater.setFullYear(now.getFullYear() + 1);

      await User.findByIdAndUpdate(referrer._id, {
        $set: {
          'subscription.plan': referrer.subscription?.plan || 'Referral',
          'subscription.active': true,
          'subscription.startDate': now,
          'subscription.expiresAt': oneYearLater,
          'subscription.autoRenew': false,
          activationMethod: 'referrals',
          referralActivatedAt: now,
          referralTarget: target
        }
      });
      console.log(`🎉 Referral activation: ${referrer._id} now active via referrals`);
    }
  } catch (e) {
    console.error('Referral activation check failed:', e.message);
  }
}

// ── Register new user ────────────────────────────────────────────────────────
// @route  POST /api/auth/createuser
// @access Public
exports.createUser = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, username, email, phone, password, referralno, role } = req.body;
  const userRole = role === 'admin' ? 'admin' : 'user';

  if (!name || !username || !email || !phone || !password) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  try {
    // ── Referral check ──────────────────────────────────────────────────────
    let referrer = null;
    const totalUsers = await User.countDocuments();
    if (totalUsers > 0) {
      if (!referralno) {
        return res.status(400).json({
          success: false,
          message: 'Referral code required. Please ask your friend to share their ID.'
        });
      }
      referrer = await User.findOne({ referralId: String(referralno).trim().toUpperCase() });
      if (!referrer) {
        return res.status(400).json({
          success: false,
          message: 'Invalid referral ID. Please ask your friend for their correct code.'
        });
      }
    }

    // ── Duplicate check ─────────────────────────────────────────────────────
    // FIX: Also check username uniqueness (original only checked email/phone)
    const existingUser = await User.findOne({ $or: [{ email }, { phone }, { username }] });
    if (existingUser) {
      const field =
        existingUser.email === email
          ? 'email'
          : existingUser.phone === phone
          ? 'phone number'
          : 'username';
      return res.status(409).json({ success: false, error: `A user with this ${field} already exists.` });
    }

    // ── Create user ─────────────────────────────────────────────────────────
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

    // FIX: User.create() already calls save(). Removed the redundant newUser.save().

    // ── Create profile ──────────────────────────────────────────────────────
    await Profile.create({
      user_id: newUser._id,
      followers: [],
      following: []
    });

    // ── Referral side-effects (non-fatal) ───────────────────────────────────
    if (referrer) {
      // Log activity
      await Activity.create({ user: newUser._id, referral: referrer._id }).catch(err =>
        console.error('Activity create failed:', err.message)
      );

      // DB notification
      await Notification.create({
        user: referrer._id,
        sender: newUser._id,
        type: 'referral_signup',
        message: `${newUser.name} joined using your referral code! 🎉`,
        url: `/profile/${newUser._id}`
      }).catch(err => console.error('Notification create failed:', err.message));

      // In-app + push notifications (fire-and-forget — non-critical)
      notifyUser(referrer._id, `${newUser.name} joined using your referral code! 🎉`, 'referral_signup').catch(() => {});
      sendPushToUser(referrer._id.toString(), {
        title: 'New Referral Signup',
        message: `${newUser.name} just created an account with your referral!`,
        url: `/profile/${newUser._id}`
      });

      // Socket notifications
      try {
        const io = getIO();
        io.to(referrer._id.toString()).emit('notification', {
          type: 'referral_signup',
          from: newUser._id,
          message: `${newUser.name} joined using your referral code! 🎉`
        });
      } catch (socketErr) {
        console.warn('Socket not ready for referral notification:', socketErr.message);
      }

      // Auto-friendship between new user and referrer
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

          try {
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
          } catch (socketErr) {
            console.warn('Socket not ready for friendship notification:', socketErr.message);
          }
        }
      } catch (err) {
        console.error('❌ Failed to auto-create friendship:', err.message);
      }

      // Referral activation check
      await checkReferralActivation(referrer);
    }

    // ── Issue JWT ───────────────────────────────────────────────────────────
    const payload = {
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        role: newUser.role
      }
    };
    const authtoken = signToken(payload);

    return res.status(201).json({
      success: true,
      authtoken: authtoken.trim(),
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        username: newUser.username,
        isAdmin: newUser.isAdmin,
        subscription: newUser.subscription,
        referralId: newUser.referralId
      },
      message: 'Account created successfully'
    });
  } catch (error) {
    console.error('createUser error:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

// ── Login existing user ──────────────────────────────────────────────────────
// @route  POST /api/auth/login
// @access Public
exports.loginUser = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { identifier, password, role } = req.body;

  try {
    let user = null;

    if (/^\S+@\S+\.\S+$/.test(identifier)) {
      user = await User.findOne({ email: identifier });
    } else if (/^\d{10}$/.test(identifier)) {
      user = await User.findOne({ phone: identifier });
    } else {
      user = await User.findOne({ username: identifier });
    }

    if (!user) {
      // FIX: Return a generic "Invalid credentials" message instead of exposing
      // whether the account exists (prevents user enumeration attacks).
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    if (role && user.role !== role) {
      return res.status(403).json({ error: 'Role mismatch. Access denied.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    // FIX: Use findByIdAndUpdate for lastActive instead of save() to avoid
    // triggering pre-save hooks (like the referralId generator) unnecessarily.
    await User.findByIdAndUpdate(user._id, { lastActive: new Date() });

    const payload = {
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role
      }
    };
    const authtoken = signToken(payload);

    // Login notification (non-critical, fire-and-forget)
    try {
      const loginNote = await Notification.create({
        user: user._id,
        type: 'custom',
        message: `Welcome back, ${user.name}! You logged in successfully.`,
        url: '/dashboard'
      });

      sendPushToUser(user._id.toString(), {
        title: 'Login Successful 🎉',
        message: `Welcome back, ${user.name}!`,
        url: '/dashboard'
      });

      const io = getIO();
      io.to(user._id.toString()).emit('notification', loginNote);
    } catch (notifErr) {
      console.warn('Login notification failed (non-fatal):', notifErr.message);
    }

    return res.json({
      success: true,
      authtoken: authtoken.trim(),
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
    console.error('Login error:', error.stack);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

// ── Reset password via OTP ───────────────────────────────────────────────────
// @route  POST /api/auth/reset-password-with-otp
// @access Public
exports.resetPasswordWithOtp = async (req, res) => {
  const { phone, newPassword } = req.body;

  if (!/^\d{10}$/.test(phone) || !newPassword || newPassword.length < 5) {
    return res.status(400).json({ success: false, message: 'Invalid input.' });
  }

  try {
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return res.json({ success: true, message: 'Password reset successful.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── Get referred users ───────────────────────────────────────────────────────
// @route  GET /api/auth/users/referred
// @access Private
exports.getReferredUsers = async (req, res) => {
  try {
    const referredUsers = await User.find({ referral: req.user.id }).select(
      'name username email phone subscription'
    );
    res.status(200).json({ referredUsers });
  } catch (err) {
    console.error('Error fetching referred users:', err.message);
    res.status(500).json({ message: 'Server error fetching referred users' });
  }
};

// ── Get user by ID ───────────────────────────────────────────────────────────
// @route  GET /api/auth/getloggeduser/:id
// @access Private
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

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
    console.error('getUserById error:', error.message);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
};

// ── Accept terms ─────────────────────────────────────────────────────────────
// @route  POST /api/auth/accept-terms
// @access Private
exports.acceptTerms = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { termsAccepted: true },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.status(200).json({ success: true, message: 'Terms accepted' });
  } catch (err) {
    console.error('acceptTerms error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};