/**
 * scripts/createTestUser.js
 *
 * Creates a fully-primed test user for payment system testing.
 *
 * What this script does:
 *   ✅ Creates a user with KYC status "verified"          → passes the KYC gate
 *   ✅ Sets an active Basic (₹2500) subscription          → passes the subscription gate
 *   ✅ Creates 30 Activity streak docs (one per day)      → eligible for 30-day streak reward
 *   ✅ Creates 30 Post docs                               → eligible for 30-post reward
 *   ✅ Creates a referrer + 3 referred users (active sub) → eligible for 3-referral reward
 *   ✅ Creates a second "referrer" user whose referral
 *      the test user used when registering               → valid referral chain
 *   ✅ Prints credentials + a Razorpay test card hint
 *
 * Run from your project root:
 *   node scripts/createTestUser.js
 *
 * Requirements:
 *   • MONGO_URI must be set in .env (script loads it via dotenv)
 *   • All models must resolve from paths relative to your project root
 *
 * ⚠️  FOR DEVELOPMENT / TESTING ONLY. Never run against production.
 */

'use strict';

require('dotenv').config({ override: true });

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── Model paths — adjust if your folder layout differs ───────────────────────
const User        = require('./models/User');
const Profile     = require('./models/Profile');
const Activity    = require('./models/Activity');
const Posts       = require('./models/Posts');
const RewardClaim = require('./models/RewardClaim');

// ── Config ────────────────────────────────────────────────────────────────────

const TEST_PASSWORD      = 'Test@1234';
const PLAN_KEY           = '2500';          // Basic plan — maps to ₹2500 JSON reward files
const PLAN_NAME          = 'Basic';
const PLAN_AMOUNT        = 2500;

// First milestones (from postsRewards.json, streakRewards.json, referralRewards.json)
const STREAK_MILESTONE   = 30;   // 30 daily streak Activity docs
const POSTS_MILESTONE    = 30;   // 30 Post docs (moderation.status = approved)
const REFERRAL_MILESTONE = 3;    // 3 active referred users

// Subscription validity window
const NOW          = new Date();
const ONE_YEAR     = new Date(NOW);
ONE_YEAR.setFullYear(ONE_YEAR.getFullYear() + 1);

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)    { console.log(`  ${msg}`); }
function section(h)  { console.log(`\n━━━  ${h}  ━━━`); }
function success(m)  { console.log(`  ✅  ${m}`); }
function warn(m)     { console.log(`  ⚠️   ${m}`); }

async function hashPw(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

/** Build an active Basic subscription sub-document */
function activeSubscription(overrides = {}) {
  return {
    plan:             PLAN_NAME,
    planAmount:       PLAN_AMOUNT,
    active:           true,
    startDate:        NOW,
    expiresAt:        ONE_YEAR,
    autoRenew:        false,
    activationMethod: 'paid',
    referralTarget:   10,
    ...overrides,
  };
}

/** Build a fully verified KYC sub-document */
function verifiedKyc() {
  return {
    status:          'verified',
    verifiedAt:      NOW,
    submittedAt:     NOW,
    score:           0.95,
    rejectionReason: null,
    liveness:        { live: true, reason: null },
    ocrData:         { aadhaar: {}, pan: {} },
    documents:       {
      aadhaarFile:      'seed/aadhaar_placeholder.pdf',
      panFile:          'seed/pan_placeholder.pdf',
      bankPassbookFile: 'seed/bank_placeholder.pdf',
      selfie:           'seed/selfie_placeholder.jpg',
    },
    thumbnails: {
      aadhaarThumb: null,
      panThumb:     null,
      bankThumb:    null,
      selfieThumb:  null,
    },
  };
}

/** Build clean trustFlags (no frozen rewards, no risk) */
function cleanTrustFlags() {
  return {
    riskScore:          0,
    riskTier:           'clean',
    referralAbuseScore: 0,
    rewardsFrozen:      false,
    referralDisabled:   false,
    kycRequired:        false,
    shadowBanned:       false,
    onWatchlist:        false,
    pendingManualReview:false,
  };
}

/**
 * Find or create a user.
 * If the email already exists, updates in-place and returns it (idempotent).
 */
async function upsertUser(fields) {
  let user = await User.findOne({ email: fields.email });

  if (user) {
    warn(`User ${fields.email} already exists — updating in-place.`);
    Object.assign(user, fields);
    await user.save();
  } else {
    user = await User.create(fields);
  }

  // Ensure a Profile document exists
  await Profile.findOneAndUpdate(
    { user_id: user._id },
    { $setOnInsert: { user_id: user._id, followers: [], following: [] } },
    { upsert: true }
  );

  return user;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Connect ──────────────────────────────────────────────────────────────
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set. Add it to your .env file.');
    process.exit(1);
  }

  console.log('\n🌱  SoShoLife — Test User Seed Script');
  console.log('─────────────────────────────────────────────────────────');

  await mongoose.connect(process.env.MONGO_URI, { connectTimeoutMS: 15_000 });
  success('Connected to MongoDB');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — Create the sponsor (the user who "referred" the test user)
  //          Needed because registration requires a valid referralId in most
  //          environments once the first user exists.
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 1 — Create sponsor user');

  const sponsorPw = await hashPw(TEST_PASSWORD);
  const sponsor   = await upsertUser({
    name:         'Seed Sponsor',
    username:     'seed_sponsor',
    email:        'seed.sponsor@testmail.local',
    phone:        '9000000001',
    password:     sponsorPw,
    role:         'user',
    isAdmin:      false,
    kyc:          verifiedKyc(),
    subscription: activeSubscription(),
    trustFlags:   cleanTrustFlags(),
  });
  success(`Sponsor created  → _id: ${sponsor._id}  referralId: ${sponsor.referralId}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2 — Create the primary test user
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 2 — Create primary test user');

  const testPw   = await hashPw(TEST_PASSWORD);
  const testUser = await upsertUser({
    name:         'Test User',
    username:     'test_payuser',
    email:        'test.payuser@testmail.local',
    phone:        '9000000002',
    password:     testPw,
    role:         'user',
    isAdmin:      false,
    referral:     sponsor._id,  // referred by sponsor

    // ── Passes the KYC gate ────────────────────────────────────────────────
    kyc:          verifiedKyc(),

    // ── Passes the subscription gate ──────────────────────────────────────
    subscription: activeSubscription(),

    // ── Clean trust profile ────────────────────────────────────────────────
    trustFlags:   cleanTrustFlags(),

    bankDetails: {
      accountNumber: '123456789012',
      ifscCode:      'SBIN0001234',
      panNumber:     'ABCDE1234F',
    },

    // Wallet starts at zero (rewards claimed via Activity/RewardClaim below)
    totalGroceryCoupons: 0,
    totalShares:         0,
    totalReferralToken:  0,

    // Mark first milestones as NOT yet claimed so the developer can
    // actually click "Claim" in the UI to test the payment flow.
    // Comment these out if you want pre-claimed state instead.
    redeemedPostSlabs:     [],
    redeemedReferralSlabs: [],
    redeemedStreakSlabs:    [],
  });
  success(`Test user created → _id: ${testUser._id}  referralId: ${testUser.referralId}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 3 — Create 30 daily streak Activity documents
  //          One doc per calendar day going back 30 days.
  //          RewardEngine counts unique calendar days, so we must spread them.
  // ══════════════════════════════════════════════════════════════════════════
  section(`Step 3 — Seed ${STREAK_MILESTONE} daily streak logs`);

  // Wipe existing streak activity for idempotency
  await Activity.deleteMany({ user: testUser._id, dailystreak: { $exists: true } });

  const streakDocs = [];
  for (let i = 0; i < STREAK_MILESTONE; i++) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - i);           // spread one per day
    d.setHours(9, 0, 0, 0);              // 09:00 each day
    streakDocs.push({ user: testUser._id, dailystreak: 1, createdAt: d, updatedAt: d });
  }
  await Activity.insertMany(streakDocs);
  success(`${STREAK_MILESTONE} streak docs inserted (days 0 – ${STREAK_MILESTONE - 1})`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 4 — Create 30 approved Post documents
  //          moderation.status must be 'approved' (engine excludes 'rejected')
  // ══════════════════════════════════════════════════════════════════════════
  section(`Step 4 — Seed ${POSTS_MILESTONE} approved posts`);

  await Posts.deleteMany({ user_id: testUser._id });

  const postDocs = [];
  for (let i = 0; i < POSTS_MILESTONE; i++) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - i);
    postDocs.push({
      user_id:    testUser._id,
      post:       `Seed post #${i + 1} — created by createTestUser.js for payment testing.`,
      visibility: 'public',
      media:      [],
      likes:      [],
      moderation: { status: 'approved', labels: [], score: 0 },
      date:       d,
    });
  }
  await Posts.insertMany(postDocs);
  success(`${POSTS_MILESTONE} approved posts inserted`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 5 — Create 3 referred users, each with an active subscription
  //          RewardEngine counts users where { referral: testUser._id,
  //          'subscription.active': true }
  // ══════════════════════════════════════════════════════════════════════════
  section(`Step 5 — Seed ${REFERRAL_MILESTONE} referred users`);

  const referredIds = [];
  for (let i = 1; i <= REFERRAL_MILESTONE; i++) {
    const pw   = await hashPw(TEST_PASSWORD);
    const ref  = await upsertUser({
      name:         `Referred User ${i}`,
      username:     `seed_referred_${i}`,
      email:        `seed.referred.${i}@testmail.local`,
      phone:        `900000001${i}`,
      password:     pw,
      role:         'user',
      isAdmin:      false,
      referral:     testUser._id,         // referred BY testUser
      kyc:          verifiedKyc(),
      subscription: activeSubscription(),
      trustFlags:   cleanTrustFlags(),
    });
    referredIds.push(ref._id);
    success(`Referred user ${i} → _id: ${ref._id}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 6 — Seed referral Activity records (for the activity history feed)
  //          One Activity per referral showing in the user's activity log.
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 6 — Seed referral Activity records');

  await Activity.deleteMany({ referral: testUser._id, userpost: { $exists: false }, dailystreak: { $exists: false } });

  const refActivityDocs = referredIds.map((rid, idx) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - idx);
    return { user: rid, referral: testUser._id, createdAt: d, updatedAt: d };
  });
  await Activity.insertMany(refActivityDocs);
  success(`${REFERRAL_MILESTONE} referral Activity records inserted`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 7 — Verify gate conditions programmatically
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 7 — Gate verification');

  const freshUser = await User.findById(testUser._id).lean();

  const kycOk   = freshUser.kyc?.status === 'verified';
  const subOk   = freshUser.subscription?.active === true
               && new Date(freshUser.subscription.expiresAt) > NOW;
  const frozenOk = !freshUser.trustFlags?.rewardsFrozen;

  kycOk   ? success('KYC gate   → PASSED (status: verified)')   : warn('KYC gate   → FAILED');
  subOk   ? success('Sub gate   → PASSED (active, not expired)') : warn('Sub gate   → FAILED');
  frozenOk? success('Trust gate → PASSED (rewards not frozen)')  : warn('Trust gate → FAILED');

  const streakDayCount = await Activity.countDocuments({ user: testUser._id, dailystreak: { $exists: true } });
  const postCount      = await Posts.countDocuments({ user_id: testUser._id, 'moderation.status': { $ne: 'rejected' } });
  const activeRefs     = await User.countDocuments({ referral: testUser._id, 'subscription.active': true });

  streakDayCount >= STREAK_MILESTONE
    ? success(`Streak eligible → ${streakDayCount} days logged (need ${STREAK_MILESTONE})`)
    : warn(`Streak NOT eligible → ${streakDayCount}/${STREAK_MILESTONE} days`);

  postCount >= POSTS_MILESTONE
    ? success(`Posts eligible  → ${postCount} posts (need ${POSTS_MILESTONE})`)
    : warn(`Posts NOT eligible → ${postCount}/${POSTS_MILESTONE} posts`);

  activeRefs >= REFERRAL_MILESTONE
    ? success(`Referral eligible → ${activeRefs} active referrals (need ${REFERRAL_MILESTONE})`)
    : warn(`Referral NOT eligible → ${activeRefs}/${REFERRAL_MILESTONE}`);

  // ══════════════════════════════════════════════════════════════════════════
  // PRINT SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              TEST USER READY FOR PAYMENT TESTING             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Email      : test.payuser@testmail.local                    ║`);
  console.log(`║  Password   : ${TEST_PASSWORD}                                    ║`);
  console.log(`║  User ID    : ${testUser._id}                   ║`);
  console.log(`║  ReferralId : ${(testUser.referralId ?? '(auto-generated)').padEnd(16)} (use in new signups)  ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  CLAIMABLE MILESTONES (first-time, nothing pre-claimed)      ║');
  console.log(`║   • Streak   30-day  → ₹500 grocery coupons                 ║`);
  console.log(`║   • Posts    30-post → ₹500 grocery + 10 shares             ║`);
  console.log(`║   • Referral 3-ref   → ₹2500 grocery + 10 shares + 300 tok  ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  RAZORPAY TEST CARDS (use in Razorpay checkout)              ║');
  console.log('║   Success  : 4111 1111 1111 1111  Exp: any  CVV: any         ║');
  console.log('║   Failure  : 4000 0000 0000 0002  Exp: any  CVV: any         ║');
  console.log('║   UPI      : success@razorpay                                ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  TESTING STEPS                                               ║');
  console.log('║   1. Log in as test.payuser@testmail.local                   ║');
  console.log('║   2. Go to Activity → Streaks tab → claim "30 Days" reward   ║');
  console.log('║   3. Go to Activity → Posts tab  → claim "30 Posts" reward   ║');
  console.log('║   4. Go to Activity → Referrals  → claim "3 Referrals"       ║');
  console.log('║   5. To test the Razorpay payment flow, log out, sign up a   ║');
  console.log(`║      new account using referralId ${(testUser.referralId ?? 'shown above').padEnd(16)} then  ║`);
  console.log('║      navigate to /subscription and pay with a test card.     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Seed script failed:', err);
  mongoose.connection.close().finally(() => process.exit(1));
});