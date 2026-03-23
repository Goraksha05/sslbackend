const { validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');


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


// ── Register new admin ────────────────────────────────────────────────────────
// @route  POST /api/auth/createadmin
// @access Public
exports.createAdmin = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { name, username, email, phone, password, role } = req.body;

  // Normalize role
  const userRole = role === 'admin' ? 'admin' : 'user';

  if (!name || !username || !email || !phone || !password) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields.',
    });
  }

  try {
    // ✅ Duplicate check
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }, { username }],
    });

    if (existingUser) {
      let field = 'username';
      if (existingUser.email === email) field = 'email';
      else if (existingUser.phone === phone) field = 'phone number';

      return res.status(409).json({
        success: false,
        error: `${field} already exists`,
      });
    }

    // ✅ Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // ✅ Create user
    const newUser = await User.create({
      name,
      username,
      email,
      phone,
      password: hashedPassword,
      role: userRole, // 🔥 IMPORTANT FIX
      isAdmin: userRole === 'admin',
    });

    // ✅ Token payload
    const payload = {
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
      },
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
        role: newUser.role,
        isAdmin: newUser.isAdmin,
      },
      message: 'Account created successfully',
    });

  } catch (error) {
    console.error('createUser error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
    });
  }
};

// ── Login existing admin ──────────────────────────────────────────────────────
// @route  POST /api/auth/adminlogin
// @access Public
exports.loginAdmin = async (req, res) => {
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

    return res.json({
      success:   true,
      authtoken: authtoken.trim(),
      user: {
        id:           user._id,
        role:         user.role,
        name:         user.name,
        email:        user.email,
        phone:        user.phone,
        username:     user.username,
        isAdmin:      user.role === 'admin' || user.role === 'super_admin',
        isSuperAdmin: user.role === 'super_admin',
        lastActive:   user.lastActive,
      },
    });
  } catch (error) {
    console.error('Login error:', error.stack);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
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
        name:         user.name,
        email:        user.email,
        phone:        user.phone,
        username:     user.username,
        isAdmin:      user.role === 'admin' || user.role === 'super_admin',
        isSuperAdmin: user.role === 'super_admin',
      },
    });
  } catch (error) {
    console.error('getUserById error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch user details' });
  }
};