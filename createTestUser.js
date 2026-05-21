/**
 * scripts/createTestUser.js
 *
 * Creates a fully-primed test user for payment + Special Offer testing.
 *
 * What this script does:
 *   ✅ Creates a user with KYC status "verified"              → passes the KYC gate
 *   ✅ Sets an active Basic (₹2500) subscription             → passes the subscription gate
 *   ✅ Creates 30 Activity streak docs (one per day)         → eligible for 30-day streak reward
 *   ✅ Creates 30 Post docs                                  → eligible for 30-post reward
 *   ✅ Creates a referrer + 3 referred users (active sub)    → eligible for 3-referral reward
 *   ✅ Creates a second "referrer" user the test user used   → valid referral chain
 *
 *   NEW — Special Offer system:
 *   ✅ Activates a live 12-hour offer window on the test user → countdown starts immediately
 *   ✅ Creates a "Special Offer" referred user whose KYC      → simulates a ₹100 locked reward
 *      is already verified (triggers creditReferralReward logic)
 *   ✅ Seeds one pending + one approved lockedReward entry    → tests both UI states
 *   ✅ Seeds a matching Payout doc for the approved reward    → visible in admin panel
 *   ✅ Verifies all gate conditions including the offer window
 *
 * Run from your project root:
 *   node scripts/createTestUser.js
 *
 * Optional flags:
 *   --expired       Set specialOffer.expiresAt to 1 hour ago (tests expired state)
 *   --no-offer      Skip the Special Offer seed entirely
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

// ── Parse CLI flags ───────────────────────────────────────────────────────────
const ARGS       = new Set(process.argv.slice(2));
const EXPIRED    = ARGS.has('--expired');    // simulate an already-expired offer
const NO_OFFER   = ARGS.has('--no-offer');   // skip Special Offer seed entirely

// ── Model paths — adjust if your folder layout differs ───────────────────────
const User        = require('./models/User');
const Profile     = require('./models/Profile');
const Activity    = require('./models/Activity');
const Posts       = require('./models/Posts');
const Payout      = require('./models/PayoutSchema');

// ── Config ────────────────────────────────────────────────────────────────────

const TEST_PASSWORD      = 'Test@1234';
const PLAN_KEY           = '2500';
const PLAN_NAME          = 'Basic';
const PLAN_AMOUNT        = 2500;

/**
 * Universal / platform referral ID — mirrors authController.js.
 *
 * When this ID is supplied at registration no referrer is linked and none of
 * the referral side-effects fire.  Used here so the sponsor user can be
 * created independently of any pre-existing referral chain, exactly as
 * ordinary visitors who arrive without a ?ref= URL param would.
 */
const UNIVERSAL_REFERRAL_ID = 'GK531980';

// Reward milestones (must match postsRewards.json / streakRewards.json / referralRewards.json)
const STREAK_MILESTONE   = 30;
const POSTS_MILESTONE    = 30;
const REFERRAL_MILESTONE = 3;

// Special Offer config (must match specialOfferController.js constants)
const OFFER_DURATION_MS    = 12 * 60 * 60 * 1000;  // 12 hours
const REWARD_PER_REFERRAL  = 100;                    // ₹100 per verified referral
const DAILY_CAP_INR        = 1800;

// Subscription validity
const NOW      = new Date();
const ONE_YEAR = new Date(NOW);
ONE_YEAR.setFullYear(ONE_YEAR.getFullYear() + 1);

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)   { console.log(`  ${msg}`); }
function section(h) { console.log(`\n━━━  ${h}  ━━━`); }
function success(m) { console.log(`  ✅  ${m}`); }
function warn(m)    { console.log(`  ⚠️   ${m}`); }
function info(m)    { console.log(`  ℹ️   ${m}`); }

async function hashPw(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

/** Build an active Basic subscription sub-document. */
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

/** Build a fully verified KYC sub-document. */
function verifiedKyc() {
  return {
    status:          'verified',
    verifiedAt:      NOW,
    submittedAt:     NOW,
    score:           0.95,
    rejectionReason: null,
    liveness:        { live: true, reason: null },
    ocrData:         { aadhaar: {}, pan: {} },
    documents: {
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

/** Build clean trustFlags (no frozen rewards, no risk). */
function cleanTrustFlags() {
  return {
    riskScore:           0,
    riskTier:            'clean',
    referralAbuseScore:  0,
    rewardsFrozen:       false,
    referralDisabled:    false,
    kycRequired:         false,
    shadowBanned:        false,
    onWatchlist:         false,
    pendingManualReview: false,
  };
}

/**
 * Build a specialOffer sub-document.
 *
 * @param {'active'|'expired'|'none'} mode
 * @param {{ totalEarned, referralCount }} [counters]
 */
function buildSpecialOffer(mode, counters = {}) {
  if (mode === 'none') {
    return {
      startAt:       null,
      expiresAt:     null,
      isActive:      false,
      totalEarned:   0,
      referralCount: 0,
    };
  }

  const startAt = new Date(NOW);

  let expiresAt;
  let isActive;

  if (mode === 'expired') {
    // Expired 1 hour ago — useful for testing the "offer ended" UI state
    expiresAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    isActive  = false;
  } else {
    // Active for the next 12 hours from now
    expiresAt = new Date(NOW.getTime() + OFFER_DURATION_MS);
    isActive  = true;
  }

  return {
    startAt,
    expiresAt,
    isActive,
    totalEarned:   counters.totalEarned   ?? 0,
    referralCount: counters.referralCount ?? 0,
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

/**
 * Resolve a referrer document from a referral code string.
 *
 * Mirrors the exact logic in authController.createUser:
 *   1. If the DB is empty (totalUsers === 0) — no referral code is required;
 *      returns null so the caller sets referral: null.
 *   2. If the code is the UNIVERSAL_REFERRAL_ID — treated as a platform
 *      sign-up (no referrer); returns null without any DB lookup.
 *   3. Otherwise — looks up the user whose referralId matches the code and
 *      returns their document.  Throws if the code is not found so seed
 *      failures are loud and obvious.
 *
 * @param {string|null} referralno   The referral code to resolve.
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function resolveReferrer(referralno) {
  const totalUsers = await User.countDocuments();

  // Rule 1: first user ever — no referral needed
  if (totalUsers === 0) {
    info('No existing users — referral code not required for first registration.');
    return null;
  }

  const normalised = String(referralno || '').trim().toUpperCase();

  // Rule 2: universal / platform referral code → no referrer linked
  if (normalised === UNIVERSAL_REFERRAL_ID) {
    info(`Universal referral ID (${UNIVERSAL_REFERRAL_ID}) used — no referrer will be linked.`);
    return null;
  }

  // Rule 3: real referral code — must match an existing user
  if (!normalised) {
    throw new Error(
      'No referral code provided and DB is non-empty. ' +
      `Either supply a valid referralId or use the universal code "${UNIVERSAL_REFERRAL_ID}".`
    );
  }

  const referrer = await User.findOne({ referralId: normalised });
  if (!referrer) {
    throw new Error(
      `Invalid referral ID "${normalised}" — no user found with this referralId. ` +
      'Check the code or use the universal platform code.'
    );
  }

  return referrer;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set. Add it to your .env file.');
    process.exit(1);
  }

  console.log('\n🌱  SoShoLife — Test User Seed Script');
  if (EXPIRED)  console.log('     Mode: EXPIRED offer (--expired flag)');
  if (NO_OFFER) console.log('     Mode: NO Special Offer (--no-offer flag)');
  console.log('─────────────────────────────────────────────────────────');

  await mongoose.connect(process.env.MONGO_URI, { connectTimeoutMS: 15_000 });
  success('Connected to MongoDB');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — Create the sponsor user
  //
  // The sponsor is the user whose referralId the test user will supply at
  // "sign-up".  We create the sponsor first and pass their generated
  // referralId to the test user's referral field.
  //
  // Referral resolution for the SPONSOR itself:
  //   • If the DB is empty (first run on a fresh DB) → no referral needed.
  //   • Otherwise → use the UNIVERSAL_REFERRAL_ID so the sponsor is created
  //     without being linked to any real user, matching what a visitor who
  //     lands directly on the site (no ?ref= param) would do.
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 1 — Create sponsor user');

  const sponsorReferrer = await resolveReferrer(UNIVERSAL_REFERRAL_ID);

  const sponsorPw = await hashPw(TEST_PASSWORD);
  const sponsor   = await upsertUser({
    name:         'Seed Sponsor',
    username:     'seed_sponsor',
    email:        'seed.sponsor@testmail.local',
    phone:        '9000000001',
    password:     sponsorPw,
    role:         'user',
    isAdmin:      false,
    // sponsorReferrer is null when UNIVERSAL_REFERRAL_ID is used — correct.
    referral:     sponsorReferrer ? sponsorReferrer._id : null,
    kyc:          verifiedKyc(),
    subscription: activeSubscription(),
    trustFlags:   cleanTrustFlags(),
  });
  success(`Sponsor created  → _id: ${sponsor._id}  referralId: ${sponsor.referralId}`);
  info(`Sponsor referralId "${sponsor.referralId}" will be used as the test user's referral code.`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2 — Create the primary test user
  //
  // Referral resolution:
  //   • We now have the sponsor in the DB, so totalUsers > 0.
  //   • We pass the sponsor's auto-generated referralId to resolveReferrer().
  //   • resolveReferrer() finds the sponsor document and returns it.
  //   • testUser.referral is set to sponsor._id — matching what authController
  //     does when a real user signs up with a valid referral code.
  //
  // specialOffer is initialised atomically inside the create call, matching
  // the fix in authController.js that eliminated the race condition where
  // the frontend could read the status before the separate findByIdAndUpdate()
  // had written the offer fields.
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 2 — Create primary test user');

  const testUserReferrer = await resolveReferrer(sponsor.referralId);
  if (!testUserReferrer) {
    // This should never happen because we just created the sponsor, but
    // guard loudly so any future schema change surfaces clearly.
    throw new Error(
      `Could not resolve sponsor referralId "${sponsor.referralId}". ` +
      'Ensure the sponsor was saved correctly in Step 1.'
    );
  }
  success(`Referral resolved → ${testUserReferrer.name} (${testUserReferrer._id})`);

  const offerMode = NO_OFFER ? 'none' : (EXPIRED ? 'expired' : 'active');
  // The offer will accumulate 1 pending + 1 approved locked reward below,
  // so set counters accordingly (unless we're skipping the offer seed).
  const offerCounters = NO_OFFER ? {} : { totalEarned: REWARD_PER_REFERRAL * 2, referralCount: 2 };

  const testPw   = await hashPw(TEST_PASSWORD);
  const testUser = await upsertUser({
    name:         'Test User',
    username:     'test_payuser',
    email:        'test.payuser@testmail.local',
    phone:        '9000000002',
    password:     testPw,
    role:         'user',
    isAdmin:      false,
    referral:     testUserReferrer._id,

    // ── KYC + subscription gates ───────────────────────────────────────────
    kyc:          verifiedKyc(),
    subscription: activeSubscription(),

    // ── Trust profile ──────────────────────────────────────────────────────
    trustFlags:   cleanTrustFlags(),

    bankDetails: {
      accountNumber: '34911897638',
      ifscCode:      'SBIN0000536',
      panNumber:     'ABCDE1234F',
    },

    // ── Wallet — starts at zero so reward claims are testable ──────────────
    totalGroceryCoupons: 0,
    totalShares:         0,
    totalReferralToken:  0,

    // Leave all slab arrays empty so the developer can click "Claim" in UI
    redeemedPostSlabs:     [],
    redeemedReferralSlabs: [],
    redeemedStreakSlabs:    [],

    // ── Special Offer — initialised atomically (mirrors authController fix) ─
    specialOffer:  buildSpecialOffer(offerMode, offerCounters),

    // lockedRewards is seeded separately below (Step 8) so we can build
    // real Payout references. Start empty here.
    lockedRewards: [],
  });
  success(`Test user created → _id: ${testUser._id}  referralId: ${testUser.referralId}`);
  if (!NO_OFFER) {
    const offerSub = testUser.specialOffer;
    if (offerMode === 'active') {
      const secsLeft = Math.round((new Date(offerSub.expiresAt) - NOW) / 1000);
      const hLeft    = Math.floor(secsLeft / 3600);
      const mLeft    = Math.floor((secsLeft % 3600) / 60);
      success(`Special Offer  → ACTIVE  expires in ${hLeft}h ${mLeft}m  (${offerSub.expiresAt.toISOString()})`);
    } else {
      info(`Special Offer  → EXPIRED (--expired flag set)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 3 — Seed 30 daily streak Activity documents
  // ══════════════════════════════════════════════════════════════════════════
  section(`Step 3 — Seed ${STREAK_MILESTONE} daily streak logs`);

  await Activity.deleteMany({ user: testUser._id, dailystreak: { $exists: true } });

  const streakDocs = [];
  for (let i = 0; i < STREAK_MILESTONE; i++) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - i);
    d.setHours(9, 0, 0, 0);
    streakDocs.push({ user: testUser._id, dailystreak: 1, createdAt: d, updatedAt: d });
  }
  await Activity.insertMany(streakDocs);
  success(`${STREAK_MILESTONE} streak docs inserted (days 0 – ${STREAK_MILESTONE - 1})`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 4 — Seed 30 approved Post documents
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
  // STEP 5 — Seed 3 referred users with active subscriptions
  //
  // Each referred user is created with testUser._id as their referral field.
  // Their own referral field (who referred them) is set to the test user's
  // referralId — matching what authController does for a normal sign-up.
  // The UNIVERSAL_REFERRAL_ID path is NOT used here because we genuinely
  // want these users linked to the test user for the referral milestone check.
  // ══════════════════════════════════════════════════════════════════════════
  section(`Step 5 — Seed ${REFERRAL_MILESTONE} referred users`);

  const referredIds = [];
  for (let i = 1; i <= REFERRAL_MILESTONE; i++) {
    const pw  = await hashPw(TEST_PASSWORD);
    const ref = await upsertUser({
      name:         `Referred User ${i}`,
      username:     `seed_referred_${i}`,
      email:        `seed.referred.${i}@testmail.local`,
      phone:        `900000001${i}`,
      password:     pw,
      role:         'user',
      isAdmin:      false,
      // These users were referred by the test user — set referral to testUser._id
      // (authController resolves the referral code to an ObjectId before storing).
      referral:     testUser._id,
      kyc:          verifiedKyc(),
      subscription: activeSubscription(),
      trustFlags:   cleanTrustFlags(),
    });
    referredIds.push(ref._id);
    success(`Referred user ${i} → _id: ${ref._id}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 6 — Seed referral Activity records (activity history feed)
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 6 — Seed referral Activity records');

  await Activity.deleteMany({
    referral:    testUser._id,
    userpost:    { $exists: false },
    dailystreak: { $exists: false },
  });

  const refActivityDocs = referredIds.map((rid, idx) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - idx);
    return { user: rid, referral: testUser._id, createdAt: d, updatedAt: d };
  });
  await Activity.insertMany(refActivityDocs);
  success(`${REFERRAL_MILESTONE} referral Activity records inserted`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 7 — Special Offer: create two "offer referral" users
  //
  //   offer_referral_1 → KYC verified   → produces an APPROVED lockedReward
  //   offer_referral_2 → KYC submitted  → produces a PENDING  lockedReward
  //
  // These are separate from the standard referred users above so the counts
  // are clean (standard referral milestone uses referredIds, not these).
  //
  // Both users are linked to the test user via referral: testUser._id,
  // exactly as authController links referred users.  The UNIVERSAL_REFERRAL_ID
  // is NOT used here because we need the referral chain for Special Offer
  // credit logic (creditReferralReward checks user.referral).
  //
  // Skipped when --no-offer is passed.
  // ══════════════════════════════════════════════════════════════════════════

  let offerReferral1 = null;
  let offerReferral2 = null;

  if (!NO_OFFER) {
    section('Step 7 — Seed Special Offer referred users');

    // Offer referral 1 — KYC verified → will trigger an approved reward
    const pw1 = await hashPw(TEST_PASSWORD);
    offerReferral1 = await upsertUser({
      name:         'Offer Referral Verified',
      username:     'seed_offer_ref_1',
      email:        'seed.offer.ref.1@testmail.local',
      phone:        '9000000021',
      password:     pw1,
      role:         'user',
      isAdmin:      false,
      referral:     testUser._id,
      kyc:          verifiedKyc(),           // verified → reward is approved
      subscription: activeSubscription(),
      trustFlags:   cleanTrustFlags(),
    });
    success(`Offer referral 1 (KYC verified) → _id: ${offerReferral1._id}`);

    // Offer referral 2 — KYC submitted → reward stays pending
    const pw2 = await hashPw(TEST_PASSWORD);
    offerReferral2 = await upsertUser({
      name:         'Offer Referral Pending',
      username:     'seed_offer_ref_2',
      email:        'seed.offer.ref.2@testmail.local',
      phone:        '9000000022',
      password:     pw2,
      role:         'user',
      isAdmin:      false,
      referral:     testUser._id,
      kyc: {
        // submitted, not yet approved — reward stays pending in the UI
        status:      'submitted',
        submittedAt: NOW,
        score:       0,
        documents:   {
          aadhaarFile:      'seed/aadhaar_placeholder.pdf',
          panFile:          'seed/pan_placeholder.pdf',
          bankPassbookFile: 'seed/bank_placeholder.pdf',
          selfie:           'seed/selfie_placeholder.jpg',
        },
        thumbnails: { aadhaarThumb: null, panThumb: null, bankThumb: null, selfieThumb: null },
      },
      subscription: activeSubscription(),
      trustFlags:   cleanTrustFlags(),
    });
    success(`Offer referral 2 (KYC submitted) → _id: ${offerReferral2._id}`);
  } else {
    section('Step 7 — Special Offer seed SKIPPED (--no-offer)');
    info('Pass --no-offer to skip the Special Offer system.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 8 — Seed lockedRewards + Payout documents
  //
  //   Reward A (approved) — linked to offer_referral_1 (KYC verified)
  //     • lockedReward.status = 'approved'
  //     • Payout doc created so admin panel shows it in Financial → Payouts
  //
  //   Reward B (pending) — linked to offer_referral_2 (KYC submitted)
  //     • lockedReward.status = 'pending'
  //     • No Payout doc yet (admin hasn't approved it)
  //
  //   Both rewards are visible in the SpecialOfferTab locked-rewards list.
  //   Only reward A is withdrawable (approved status).
  //
  // Skipped when --no-offer is passed.
  // ══════════════════════════════════════════════════════════════════════════

  if (!NO_OFFER && offerReferral1 && offerReferral2) {
    section('Step 8 — Seed lockedRewards and Payout documents');

    // ── Remove any existing offer payouts for the test user (idempotency) ───
    await Payout.deleteMany({ user: testUser._id, rewardType: 'special_offer' });

    // ── Reward A: approved ────────────────────────────────────────────────────
    // Create the Payout document first so we can store its _id on the reward.
    const payoutA = await Payout.create({
      user:          testUser._id,
      rewardType:    'special_offer',
      milestone:     `special_offer_referral_${offerReferral1._id}`,
      planKey:       PLAN_KEY,
      breakdown:     { groceryCoupons: REWARD_PER_REFERRAL, shares: 0, referralToken: 0 },
      cashAmountINR:  REWARD_PER_REFERRAL,
      totalAmountINR: REWARD_PER_REFERRAL,
      objectRewardsHeld: { sharesHeld: 0, referralTokenHeld: 0 },
      bankDetails: {
        accountNumber: '123456789012',
        ifscCode:      'SBIN0001234',
        panNumber:     'ABCDE1234F',
      },
      // 'pending' at first — admin approves it, which also approves the lockedReward.
      // For seed purposes we jump straight to approved so the UI shows it withdrawable.
      status:        'pending',
      userRequested: false,
      notes:         `[SEED] Special offer referral reward — ₹${REWARD_PER_REFERRAL} for referring ${offerReferral1._id}`,
    });
    success(`Payout A created  → _id: ${payoutA._id}  status: pending  amount: ₹${REWARD_PER_REFERRAL}`);

    // ── Push both lockedRewards onto the test user ────────────────────────────
    // We use $push so upsertUser's Object.assign doesn't race with the save.
    const createdAtA = new Date(NOW.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    const createdAtB = new Date(NOW.getTime() - 30 * 60 * 1000);     // 30 min ago

    await User.findByIdAndUpdate(testUser._id, {
      $push: {
        lockedRewards: {
          $each: [
            {
              amount:         REWARD_PER_REFERRAL,
              type:           'special_offer',
              status:         'approved',          // ← withdrawable
              referredUserId: offerReferral1._id,
              payoutId:       payoutA._id,
              createdAt:      createdAtA,
            },
            {
              amount:         REWARD_PER_REFERRAL,
              type:           'special_offer',
              status:         'pending',           // ← waiting for admin approval
              referredUserId: offerReferral2._id,
              payoutId:       null,
              createdAt:      createdAtB,
            },
          ],
        },
      },
    });

    success(`lockedReward A → approved  ₹${REWARD_PER_REFERRAL}  (referral: ${offerReferral1._id})`);
    success(`lockedReward B → pending   ₹${REWARD_PER_REFERRAL}  (referral: ${offerReferral2._id})`);
    info('Reward A is withdrawable. Reward B is visible but locked until admin approves.');
    info(`To approve reward B: set lockedRewards[].status = 'approved' in DB, then create a Payout doc.`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 9 — Gate verification
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 9 — Gate verification');

  const freshUser = await User.findById(testUser._id).lean();

  // Core reward gates
  const kycOk    = freshUser.kyc?.status === 'verified';
  const subOk    = freshUser.subscription?.active === true
                && new Date(freshUser.subscription.expiresAt) > NOW;
  const frozenOk = !freshUser.trustFlags?.rewardsFrozen;

  kycOk    ? success('KYC gate    → PASSED (status: verified)')    : warn('KYC gate    → FAILED');
  subOk    ? success('Sub gate    → PASSED (active, not expired)')  : warn('Sub gate    → FAILED');
  frozenOk ? success('Trust gate  → PASSED (rewards not frozen)')   : warn('Trust gate  → FAILED');

  const streakDayCount = await Activity.countDocuments({
    user:        testUser._id,
    dailystreak: { $exists: true },
  });
  const postCount  = await Posts.countDocuments({
    user_id:             testUser._id,
    'moderation.status': { $ne: 'rejected' },
  });
  const activeRefs = await User.countDocuments({
    referral:            testUser._id,
    'subscription.active': true,
  });

  streakDayCount >= STREAK_MILESTONE
    ? success(`Streak eligible  → ${streakDayCount} days (need ${STREAK_MILESTONE})`)
    : warn(`Streak NOT eligible → ${streakDayCount}/${STREAK_MILESTONE} days`);

  postCount >= POSTS_MILESTONE
    ? success(`Posts eligible   → ${postCount} posts (need ${POSTS_MILESTONE})`)
    : warn(`Posts NOT eligible  → ${postCount}/${POSTS_MILESTONE} posts`);

  activeRefs >= REFERRAL_MILESTONE
    ? success(`Referral eligible → ${activeRefs} active referrals (need ${REFERRAL_MILESTONE})`)
    : warn(`Referral NOT eligible → ${activeRefs}/${REFERRAL_MILESTONE}`);

  // Special Offer gate checks
  if (!NO_OFFER) {
    const offer        = freshUser.specialOffer;
    const offerActive  = offer?.isActive && offer?.expiresAt && new Date(offer.expiresAt) > NOW;
    const lockedCount  = (freshUser.lockedRewards ?? []).filter(r => r.type === 'special_offer').length;
    const approvedCount= (freshUser.lockedRewards ?? []).filter(r => r.type === 'special_offer' && r.status === 'approved').length;

    offerActive
      ? success(`Offer window    → ACTIVE  expiresAt: ${new Date(offer.expiresAt).toISOString()}`)
      : (EXPIRED
          ? info(`Offer window    → EXPIRED (--expired flag set — expected)`)
          : warn(`Offer window    → NOT active — check specialOffer fields`));

    lockedCount > 0
      ? success(`Locked rewards  → ${lockedCount} total  (${approvedCount} approved, ${lockedCount - approvedCount} pending)`)
      : warn('Locked rewards  → none found');

    const payoutCount = await Payout.countDocuments({ user: testUser._id, rewardType: 'special_offer' });
    payoutCount > 0
      ? success(`Payout docs     → ${payoutCount} in DB (visible in admin Financial tab)`)
      : warn('Payout docs     → none found');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════

  const offerExpiresAt = NO_OFFER ? null : (freshUser.specialOffer?.expiresAt ?? null);
  const offerExpiresStr = offerExpiresAt
    ? new Date(offerExpiresAt).toISOString()
    : 'N/A';

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        TEST USER READY FOR PAYMENT + SPECIAL OFFER           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Email      : test.payuser@testmail.local                    ║`);
  console.log(`║  Password   : ${TEST_PASSWORD}                               ║`);
  console.log(`║  User ID    : ${testUser._id}                                ║`);
  console.log(`║  ReferralId : ${(testUser.referralId ?? '(auto-generated)').padEnd(16)} (use in new signups)  ║`);
  console.log(`║  Referred by: ${sponsor.referralId.padEnd(16)} (sponsor)                      ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  CLAIMABLE MILESTONES (nothing pre-claimed)                  ║');
  console.log(`║   • Streak   30-day  → ₹500 grocery coupons                  ║`);
  console.log(`║   • Posts    30-post → ₹500 grocery + 10 shares              ║`);
  console.log(`║   • Referral 3-ref   → ₹2500 grocery + 10 shares + 300 tok   ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  if (!NO_OFFER) {
    const modeLabel = EXPIRED ? 'EXPIRED (testing expired state)' : 'ACTIVE ✅';
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  SPECIAL OFFER (12-hour registration window)                 ║');
    console.log(`║   Status     : ${modeLabel.padEnd(45)}                       ║`);
    console.log(`║   Expires at : ${offerExpiresStr.padEnd(45)}                 ║`);
    console.log('║   Rewards seeded:                                            ║');
    console.log(`║     A) ₹${REWARD_PER_REFERRAL} — approved  → withdrawable now                 ║`);
    console.log(`║     B) ₹${REWARD_PER_REFERRAL} — pending   → waiting for admin approval       ║`);
    console.log('║   Testing steps:                                             ║');
    console.log('║     1. Log in → Special Offer tab should appear immediately  ║');
    console.log('║     2. Countdown must tick down from ~12h remaining          ║');
    console.log('║     3. "Approved Rewards" section shows ₹100 withdrawable    ║');
    console.log('║     4. "Pending Rewards" section shows ₹100 awaiting review  ║');
    console.log('║     5. Click "Withdraw" → confirm bank details dialog        ║');
    console.log('║     6. Admin panel → Financial → Payouts shows the request   ║');
    console.log('║   Expired-state test:                                        ║');
    console.log('║     Run with --expired to set expiresAt in the past          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  RAZORPAY TEST CARDS                                         ║');
  console.log('║   Success  : 4111 1111 1111 1111  Exp: any  CVV: any         ║');
  console.log('║   Failure  : 4000 0000 0000 0002  Exp: any  CVV: any         ║');
  console.log('║   UPI      : success@razorpay                                ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  GENERAL TESTING STEPS                                       ║');
  console.log('║   1. Log in as test.payuser@testmail.local                   ║');
  console.log('║   2. Activity → Streaks → claim "30 Days" reward             ║');
  console.log('║   3. Activity → Posts   → claim "30 Posts" reward            ║');
  console.log('║   4. Activity → Referrals → claim "3 Referrals" reward       ║');
  console.log('║   5. To test Razorpay: log out, sign up a new account using  ║');
  console.log(`║      referralId ${(testUser.referralId ?? 'shown above').padEnd(16)}, then go to /subscription ║`);
  console.log('║                                                               ║');
  console.log('║  REFERRAL CODE BEHAVIOUR (mirrors authController.js)         ║');
  console.log(`║   Universal code "${UNIVERSAL_REFERRAL_ID}" → no referrer linked (platform)  ║`);
  console.log('║   Any valid referralId  → user is linked to that referrer    ║');
  console.log('║   Empty / invalid code  → registration is rejected           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Seed script failed:', err);
  mongoose.connection.close().finally(() => process.exit(1));
});