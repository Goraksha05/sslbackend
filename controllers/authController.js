const { validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Activity = require('../models/Activity');
const Profile = require('../models/Profile');
const Notification = require('../models/Notification');
const Friendship = require('../models/Friendship');
const { getIO } = require('../sockets/socketManager');
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
          'subscription.plan':       referrer.subscription?.plan || 'Referral',
          'subscription.active':     true,
          'subscription.startDate':  now,
          'subscription.expiresAt':  oneYearLater,
          'subscription.autoRenew':  false,
          activationMethod:          'referrals',
          referralActivatedAt:       now,
          referralTarget:            target,
        },
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
          message: 'Referral code required. Please ask your friend to share their ID.',
        });
      }
      referrer = await User.findOne({ referralId: String(referralno).trim().toUpperCase() });
      if (!referrer) {
        return res.status(400).json({
          success: false,
          message: 'Invalid referral ID. Please ask your friend for their correct code.',
        });
      }
    }

    // ── Duplicate check ─────────────────────────────────────────────────────
    const existingUser = await User.findOne({ $or: [{ email }, { phone }, { username }] });
    if (existingUser) {
      const field =
        existingUser.email    === email    ? 'email'       :
        existingUser.phone    === phone    ? 'phone number':
        'username';
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
      role:     userRole,
      isAdmin:  false,
    });

    // ── Create profile ──────────────────────────────────────────────────────
    await Profile.create({ user_id: newUser._id, followers: [], following: [] });

    // ── Referral side-effects (non-fatal) ───────────────────────────────────
    if (referrer) {
      await Activity.create({ user: newUser._id, referral: referrer._id }).catch(err =>
        console.error('Activity create failed:', err.message)
      );

      await Notification.create({
        user:    referrer._id,
        sender:  newUser._id,
        type:    'referral_signup',
        message: `${newUser.name} joined using your referral code! 🎉`,
        url:     `/profile/${newUser._id}`,
      }).catch(err => console.error('Notification create failed:', err.message));

      // In-app + push notifications (fire-and-forget)
      notifyUser(referrer._id, `${newUser.name} joined using your referral code! 🎉`, 'referral_signup').catch(() => {});
      sendPushToUser(referrer._id.toString(), {
        title:   'New Referral Signup',
        message: `${newUser.name} just created an account with your referral!`,
        url:     `/profile/${newUser._id}`,
      });

      try {
        const io = getIO();
        io.to(referrer._id.toString()).emit('notification', {
          type:    'referral_signup',
          from:    newUser._id,
          message: `${newUser.name} joined using your referral code! 🎉`,
        });
      } catch (socketErr) {
        console.warn('Socket not ready for referral notification:', socketErr.message);
      }

      // Auto-friendship between new user and referrer
      try {
        const existingFriendship = await Friendship.findOne({
          $or: [
            { requester: referrer._id, recipient: newUser._id },
            { requester: newUser._id, recipient: referrer._id },
          ],
        });

        if (!existingFriendship) {
          await Friendship.create({
            requester: referrer._id,
            recipient: newUser._id,
            status:    'accepted',
          });
          console.log(`🤝 Auto-friendship created between ${referrer._id} and ${newUser._id}`);

          try {
            const io = getIO();
            io.to(referrer._id.toString()).emit('notification', {
              type:    'friend_accept',
              from:    newUser._id,
              message: `${newUser.name} is now your friend (via referral)!`,
            });
            io.to(newUser._id.toString()).emit('notification', {
              type:    'friend_accept',
              from:    referrer._id,
              message: `You are now friends with ${referrer.name}!`,
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

      // FIX: Record referral edge in device graph.
      // Was previously placed AFTER the closing brace of the try/catch block —
      // i.e. outside the function body — and referenced the undefined variable
      // `savedUser` (correct name is `newUser`). Moved inside try block, using
      // setImmediate so it never delays the HTTP response.
      const { recordReferral } = require('../services/deviceGraphUpdater');
      setImmediate(() =>
        recordReferral(referrer._id, newUser._id).catch(err =>
          console.error('[createUser] recordReferral failed:', err.message)
        )
      );
    }

    // ── Issue JWT ───────────────────────────────────────────────────────────
    const payload = {
      user: {
        id:    newUser._id.toString(),
        name:  newUser.name,
        email: newUser.email,
        role:  newUser.role,
      },
    };
    const authtoken = signToken(payload);

    return res.status(201).json({
      success:   true,
      authtoken: authtoken.trim(),
      user: {
        id:           newUser._id,
        name:         newUser.name,
        email:        newUser.email,
        phone:        newUser.phone,
        username:     newUser.username,
        isAdmin:      newUser.isAdmin,
        subscription: newUser.subscription,
        referralId:   newUser.referralId,
      },
      message: 'Account created successfully',
    });
  } catch (error) {
    console.error('createUser error:', error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
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
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    if (role && user.role !== role) {
      return res.status(403).json({ error: 'Role mismatch. Access denied.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    await User.findByIdAndUpdate(user._id, { lastActive: new Date() });

    const payload = {
      user: {
        id:    user._id.toString(),
        name:  user.name,
        email: user.email,
        role:  user.role,
      },
    };
    const authtoken = signToken(payload);

    // Trust & Safety: update device graph on login (fire-and-forget)
    const fpHash = req.headers['x-fp-hash'] || null;
    const { recordLogin } = require('../services/deviceGraphUpdater');
    const { computeMultiAccountScore } = require('../services/multiAccountScorer');
    const { executeDefenseActions } = require('../services/defenseActions');

    setImmediate(async () => {
      try {
        await recordLogin(user._id, fpHash, req.ip);
        const result = await computeMultiAccountScore(user._id, { fpHash, ip: req.ip });
        if (result.tier !== 'clean') {
          await executeDefenseActions(user._id, result, 'login', { fpHash, ip: req.ip });
        }
      } catch (err) {
        console.error('[trust/login]', err.message);
      }
    });

    if (user.kyc?.status === 'required') {
      notifyUser(user._id, '⚠️ Please complete your KYC', 'kyc_required').catch(() => {});
    }

    // Login notification (non-critical, fire-and-forget)
    try {
      const loginNote = await Notification.create({
        user:    user._id,
        type:    'custom',
        message: `Welcome back, ${user.name}! You logged in successfully.`,
        url:     '/dashboard',
      });
      sendPushToUser(user._id.toString(), {
        title:   'Login Successful 🎉',
        message: `Welcome back, ${user.name}!`,
        url:     '/dashboard',
      });
      const io = getIO();
      io.to(user._id.toString()).emit('notification', loginNote);
    } catch (notifErr) {
      console.warn('Login notification failed (non-fatal):', notifErr.message);
    }

    return res.json({
      success:   true,
      authtoken: authtoken.trim(),
      user: {
        id:           user._id,
        role:         user.role,
        referral:     user.referral,
        name:         user.name,
        email:        user.email,
        phone:        user.phone,
        username:     user.username,
        isAdmin:      user.role === 'admin' || user.role === 'super_admin',
        isSuperAdmin: user.role === 'super_admin',
        subscription: user.subscription,
        referralId:   user.referralId,
        lastActive:   user.lastActive,
      },
    });
  } catch (error) {
    console.error('Login error:', error.stack);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
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
    return res.status(200).json({ referredUsers });
  } catch (err) {
    console.error('Error fetching referred users:', err.message);
    return res.status(500).json({ message: 'Server error fetching referred users' });
  }
};

// ── Get user by ID ───────────────────────────────────────────────────────────
// @route  GET /api/auth/getloggeduser/:id
// @access Private
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.json({
      success: true,
      user: {
        id:           user._id,
        role:         user.role,
        referral:     user.referral,
        name:         user.name,
        email:        user.email,
        phone:        user.phone,
        username:     user.username,
        isAdmin:      user.role === 'admin' || user.role === 'super_admin',
        isSuperAdmin: user.role === 'super_admin',
        subscription: user.subscription,
        referralId:   user.referralId,
      },
    });
  } catch (error) {
    console.error('getUserById error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch user details' });
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
    return res.status(200).json({ success: true, message: 'Terms accepted' });
  } catch (err) {
    console.error('acceptTerms error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Save bank details ─────────────────────────────────────────────────────────
exports.saveBankDetails = async (req, res) => {
  try {
    const { accountNumber, ifscCode, panNumber, bankName } = req.body;
 
    // ── 1. At least one field must be present ──────────────────────────────
    if (!accountNumber && !ifscCode && !panNumber) {
      return res.status(400).json({
        success: false,
        message: 'At least one of accountNumber, ifscCode, or panNumber is required.',
      });
    }
 
    // ── 2. Format validation ───────────────────────────────────────────────
    if (accountNumber && !/^\d{9,18}$/.test(accountNumber.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid account number — must be 9 to 18 digits.',
      });
    }
 
    if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(ifscCode.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid IFSC code — expected format: AAAA0XXXXXX (11 characters).',
      });
    }
 
    if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(panNumber.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid PAN number — expected format: ABCDE1234F (10 characters).',
      });
    }
 
    // ── 3. Load user ───────────────────────────────────────────────────────
    const userId = req.user?.id || req.user?._id;
    const user   = await User.findById(userId);
 
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
 
    // ── 4. Merge — only overwrite with non-empty incoming values ──────────
    if (!user.bankDetails) user.bankDetails = {};
 
    if (accountNumber?.trim()) {
      user.bankDetails.accountNumber = accountNumber.trim();
    }
    if (ifscCode?.trim()) {
      user.bankDetails.ifscCode = ifscCode.trim().toUpperCase();
    }
    if (panNumber?.trim()) {
      user.bankDetails.panNumber = panNumber.trim().toUpperCase();
    }
 
    // bankName is informational (UI display only) — not persisted unless you
    // add a bankDetails.bankName field to the User schema.
    if (bankName) {
      console.log(`[save-bank-details] user=${userId} selected bank: ${bankName}`);
    }
 
    // ── 5. Persist ────────────────────────────────────────────────────────
    await user.save();
 
    console.log(
      `[save-bank-details] ✅ Updated for user=${userId}` +
      ` acct=****${(user.bankDetails.accountNumber || '').slice(-4)}` +
      ` ifsc=${user.bankDetails.ifscCode || '—'}`
    );
 
    return res.status(200).json({
      success: true,
      message: 'Bank details saved successfully.',
    });
 
  } catch (err) {
    console.error('[POST /api/auth/save-bank-details]', err);
    return res.status(500).json({
      success: false,
      message: 'Server error while saving bank details. Please try again.',
    });
  }
};