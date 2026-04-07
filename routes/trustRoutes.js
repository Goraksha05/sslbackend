// routes/trustRoutes.js
// All Trust & Safety API endpoints.
// Mount in index.js: app.use('/api/trust', require('./routes/trustRoutes'));
//
// Endpoints:
//   POST   /api/trust/signal              ← Browser SDK signal ingestion
//   POST   /api/trust/fingerprint         ← Device fingerprint registration
//   GET    /api/trust/score/:userId        ← Get user's current trust scores
//   POST   /api/trust/score/:userId/recompute  ← Force rescore (admin)
//   GET    /api/trust/fraud-events         ← Paginated fraud event log (admin)
//   POST   /api/trust/fraud-events/:id/resolve ← Mark event as resolved (admin)
//   POST   /api/trust/reverse-action       ← Reverse a defense action (admin)
//   GET    /api/trust/clusters             ← List high-risk clusters (admin)
//   POST   /api/trust/investigate          ← LLM investigation agent (admin)
//   POST   /api/trust/simulate             ← Run economic simulation (admin)
'use strict';

const express   = require('express');
const router    = express.Router();

const fetchUser   = require('../middleware/fetchuser');
const { verifyAdmin } = require('../middleware/rbac');

const BehaviorSignal             = require('../models/BehaviorSignal');
const DeviceFingerprint          = require('../models/DeviceFingerprint');
const FraudEvent                 = require('../models/FraudEvent');
const DeviceGraph                = require('../models/DeviceGraph');
const User                       = require('../models/User');

const { computeMultiAccountScore }   = require('../services/multiAccountScorer');
const { computeReferralAbuseScore }  = require('../services/referralAbuseScorer');
const { executeDefenseActions, reverseDefenseAction } = require('../services/defenseActions');
const { recordLogin }                = require('../services/deviceGraphUpdater');
const { runInvestigation }           = require('../services/investigationAgent');
const { runSimulation }              = require('../services/simulationEngine');

// ── Fingerprint hash utility (server-side SHA-256 of request headers) ─────────
const crypto = require('crypto');
function buildFpHash(signals) {
  const canonical = [
    signals.userAgent    || '',
    signals.screenRes    || '',
    signals.colorDepth   || '',
    signals.timezone     || '',
    (signals.languages   || []).join(','),
    signals.platform     || '',
    signals.gpuRenderer  || '',
    signals.gpuVendor    || '',
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ── Signal type alias map ──────────────────────────────────────────────────────
// Normalises common SDK shorthand names → the enum values in BehaviorSignal.js.
// Add entries here when the frontend SDK uses a different name than the schema.
const SIGNAL_TYPE_ALIASES = {
  scroll:       'scroll_event',
  click:        'click_event',
  typing:       'typing_burst',
  mouse:        'mouse_move',
  nav:          'navigation',
  navigate:     'navigation',
  session_open: 'session_start',
  session_close:'session_end',
  post:         'post_created',
  referral:     'referral_sent',
  form:         'form_interaction',
};

// ── POST /api/trust/signal ─────────────────────────────────────────────────────
// Browser SDK sends behavioral events. Authenticated user required.
// Always responds 202 so bots cannot fingerprint validation errors.
router.post('/signal', fetchUser, async (req, res) => {
  // Always ack immediately — signal loss is acceptable, client must not retry on error
  res.status(202).json({ ok: true });

  try {
    const { signalType: rawType, payload, clientTimestamp, sessionId } = req.body;

    // Silently drop malformed signals rather than returning 400
    if (!rawType || payload === null || payload === undefined) return;

    // Normalise alias → canonical enum value
    const signalType = SIGNAL_TYPE_ALIASES[rawType] ?? rawType;

    // Validate against the known enum before hitting Mongoose so we get a
    // clear server-side log instead of a Mongoose ValidationError
    const VALID_SIGNAL_TYPES = [
      'typing_burst', 'mouse_move', 'scroll_event', 'click_event',
      'session_start', 'session_end', 'navigation', 'post_created',
      'referral_sent', 'form_interaction',
    ];

    if (!VALID_SIGNAL_TYPES.includes(signalType)) {
      console.debug(`[trust/signal] Unknown signalType ignored: "${rawType}"`);
      return;
    }

    await BehaviorSignal.create({
      userId:          req.user.id,
      signalType,
      payload:         typeof payload === 'object' ? payload : { value: payload },
      clientTimestamp,
      sessionId,
      ip:              req.ip,
      receivedOn:      new Date(),   // FIX: schema field is `receivedOn`, not `receivedAt`
    });
  } catch (err) {
    // Non-fatal — log but never surface to client
    console.error('[trust/signal]', err.message);
  }
});

// ── POST /api/trust/fingerprint ───────────────────────────────────────────────
// Called once per session by the browser SDK with device signals.
// Returns fpHash to include in subsequent API requests as X-FP-Hash header.
router.post('/fingerprint', fetchUser, async (req, res) => {
  try {
    const signals = req.body;
    const fpHash  = buildFpHash(signals);

    const fp = await DeviceFingerprint.findOneAndUpdate(
      { fpHash },
      {
        $addToSet:    { userIds: req.user.id },
        $set:         { lastSeenAt: new Date(), signals },
        $setOnInsert: { fpHash, firstSeenAt: new Date() },
      },
      { upsert: true, new: true }
    );

    fp.evaluateRisk();
    await fp.save();

    // Update device graph
    await recordLogin(req.user.id, fpHash, req.ip);

    res.json({ fpHash });
  } catch (err) {
    console.error('[trust/fingerprint]', err.message);
    res.status(500).json({ message: 'Fingerprint registration failed' });
  }
});

// ── GET /api/trust/score/:userId ──────────────────────────────────────────────
// Returns cached trust scores from User.trustFlags. Admin only.
router.get('/score/:userId', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('name email trustFlags')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      userId:     req.params.userId,
      name:       user.name,
      email:      user.email,
      trustFlags: user.trustFlags || {},
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/trust/score/:userId/recompute ───────────────────────────────────
// Force a full rescore for one user. Admin only.
router.post('/score/:userId/recompute', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const userId  = req.params.userId;
    const fpHash  = req.body.fpHash;
    const ip      = req.body.ip;

    const [maResult, raResult] = await Promise.all([
      computeMultiAccountScore(userId, { fpHash, ip }),
      computeReferralAbuseScore(userId),
    ]);

    const result = await executeDefenseActions(
      userId, maResult, 'manual_review',
      { triggeredBy: req.user.id },
      { referralAbuse: raResult.score }
    );

    res.json({
      userId,
      multiAccountScore:  maResult.score,
      multiAccountTier:   maResult.tier,
      breakdown:          maResult.breakdown,
      referralAbuseScore: raResult.score,
      explanation:        maResult.explanation,
      actionsTriggered:   result.actions,
      fraudEventId:       result.fraudEventId,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/trust/fraud-events ───────────────────────────────────────────────
// Paginated fraud event log with optional filters. Admin only.
router.get('/fraud-events', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const {
      userId, minScore, tier, resolved,
      page = 1, limit = 50,
    } = req.query;

    const filter = {};
    if (userId)   filter.userId = userId;
    if (minScore) filter['scores.aggregateRiskScore'] = { $gte: parseFloat(minScore) };
    if (tier) {
      const tierMin = { watchlist: 0.45, kyc_gate: 0.60, auto_flag: 0.75 };
      filter['scores.aggregateRiskScore'] = { $gte: tierMin[tier] || 0 };
    }
    if (resolved !== undefined) filter.resolved = resolved === 'true';

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const [events, total] = await Promise.all([
      FraudEvent.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      FraudEvent.countDocuments(filter),
    ]);

    res.json({ events, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/trust/fraud-events/:id/resolve ──────────────────────────────────
// Admin resolves a fraud event. Admin only.
router.post('/fraud-events/:id/resolve', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const { resolution, note } = req.body;
    const validResolutions = ['false_positive', 'confirmed_fraud', 'escalated', 'no_action'];
    if (!validResolutions.includes(resolution)) {
      return res.status(400).json({ message: `resolution must be one of: ${validResolutions.join(', ')}` });
    }

    await FraudEvent.findByIdAndUpdate(req.params.id, {
      $set: {
        resolved:   true,
        resolvedBy: req.user.id,
        resolvedAt: new Date(),
        resolution,
      },
    });

    res.json({ ok: true, fraudEventId: req.params.id, resolution });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/trust/reverse-action ────────────────────────────────────────────
// Reverse a defense action (unfreeze rewards, re-enable referral, etc.). Admin only.
router.post('/reverse-action', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const { fraudEventId, resolution, note } = req.body;
    if (!fraudEventId || !resolution) {
      return res.status(400).json({ message: 'fraudEventId and resolution required' });
    }

    const result = await reverseDefenseAction(fraudEventId, req.user.id, resolution, note);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/trust/clusters ───────────────────────────────────────────────────
// List device graph clusters by size, sorted by risk. Admin only.
router.get('/clusters', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const { minSize = 3, limit = 50 } = req.query;

    const pipeline = [
      { $match: { entityType: 'user', primaryClusterId: { $ne: null } } },
      {
        $group: {
          _id:             '$primaryClusterId',
          userCount:       { $sum: 1 },
          avgBetweenness:  { $avg: '$betweennessScore' },
          riskFlags:       { $push: '$riskFlags' },
        },
      },
      { $match: { userCount: { $gte: parseInt(minSize) } } },
      { $sort:  { userCount: -1 } },
      { $limit: parseInt(limit) },
    ];

    const clusters = await DeviceGraph.aggregate(pipeline);

    // Flatten risk flags
    const enriched = clusters.map(c => ({
      clusterId:      c._id,
      userCount:      c.userCount,
      avgBetweenness: Math.round((c.avgBetweenness || 0) * 100) / 100,
      allFlags:       [...new Set((c.riskFlags || []).flat())],
    }));

    res.json({ clusters: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/trust/investigate ───────────────────────────────────────────────
// LLM investigation agent. Admin only. Rate-limited (5 req/min per admin).
router.post('/investigate', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ message: 'query is required' });
    }
    if (query.length > 500) {
      return res.status(400).json({ message: 'query must be ≤ 500 characters' });
    }

    const result = await runInvestigation(query.trim(), req.user.id);
    res.json(result);
  } catch (err) {
    console.error('[trust/investigate]', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/trust/simulate ──────────────────────────────────────────────────
// Economic simulation endpoint. Admin only.
router.post('/simulate', fetchUser, verifyAdmin, async (req, res) => {
  try {
    const { plan, totalUsers, months, runs, overrides } = req.body;

    const result = await runSimulation({
      plan:       plan       || '2500',
      totalUsers: totalUsers || 10000,
      months:     months     || 6,
      runs:       runs       || 1000,
      overrides:  overrides  || {},
    });

    res.json(result);
  } catch (err) {
    console.error('[trust/simulate]', err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;