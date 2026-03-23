// jobs/vectorBuilderJob.js
// Nightly job (runs at 02:00 IST) that reads 30 days of BehaviorSignal
// documents for every active user and computes/updates their BehaviorVector.
//
// Schedule in your main cron file:
//   const cron = require('node-cron');
//   const { runVectorBuilderJob } = require('./jobs/vectorBuilderJob');
//   cron.schedule('0 20 * * *', runVectorBuilderJob);  // 20:30 UTC = 02:00 IST
//
// Shannon entropy helper, rolling statistics, and anomaly heuristics are all
// pure JS — no ML library required at this stage.
'use strict';

const BehaviorSignal  = require('../models/BehaviorSignal');
const BehaviorVector  = require('../models/BehaviorVector');
const User            = require('../models/User');

const WINDOW_DAYS = 30;

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Shannon entropy of an array of numbers (normalised to bits). */
function shannonEntropy(values) {
  if (!values || values.length < 2) return 0;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  // Normalise to [0,1] then compute distribution entropy
  const probs = values.map(v => Math.abs(v - mean) / (mean + 1e-9));
  const total = probs.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let H = 0;
  for (const p of probs) {
    const pn = p / total;
    if (pn > 0) H -= pn * Math.log2(pn);
  }
  return H;
}

/** Coefficient of variation (stddev / mean). */
function coefficientOfVariation(values) {
  if (!values || values.length < 2) return 0;
  const n    = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  return Math.sqrt(variance) / mean;
}

/** Mean of array. */
function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Standard deviation. */
function stdDev(arr) {
  if (!arr || arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / arr.length);
}

// ── Signal processors ─────────────────────────────────────────────────────────

function processLoginIntervals(sessionStarts) {
  if (sessionStarts.length < 3) return null;
  const times = sessionStarts
    .map(s => new Date(s.receivedOn).getTime())
    .sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  return shannonEntropy(intervals);
}

function processTypingSignals(typingBursts) {
  if (typingBursts.length === 0) return { mean: null, stdDev: null };
  const wpms = typingBursts
    .map(s => s.payload?.wpm)
    .filter(v => v != null && v > 0);
  return { mean: mean(wpms), stdDev: stdDev(wpms) };
}

function processClickIntervals(clickEvents) {
  if (clickEvents.length < 3) return null;
  const intervals = clickEvents
    .map(s => s.payload?.interval_ms_since_last)
    .filter(v => v != null && v > 0);
  return coefficientOfVariation(intervals);
}

function processScrollEntropy(scrollEvents) {
  if (scrollEvents.length < 5) return null;
  const intervals = scrollEvents
    .map(s => s.payload?.interval_ms_since_last)
    .filter(v => v != null && v > 0);
  return shannonEntropy(intervals);
}

function processSessionDurations(sessionEnds) {
  if (sessionEnds.length === 0) return null;
  const durations = sessionEnds
    .map(s => s.payload?.duration_ms)
    .filter(v => v != null && v > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  // P50 (median)
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2
    ? durations[mid]
    : (durations[mid - 1] + durations[mid]) / 2;
}

function processPostCadence(postCreated) {
  if (postCreated.length < 3) return null;
  const intervals = postCreated
    .map(s => s.payload?.interval_ms_since_last_post)
    .filter(v => v != null && v > 0);
  if (intervals.length < 2) return null;
  // Regularity = 1 - CV (high CV = irregular = human; low CV = bot)
  const cv = coefficientOfVariation(intervals);
  return Math.max(0, 1 - cv);
}

function processReferralBurst(referralSent) {
  if (referralSent.length === 0) return 0;
  // Find max referrals in any 60-second window
  const times = referralSent
    .map(s => new Date(s.receivedAt).getTime())
    .sort((a, b) => a - b);
  let maxBurst = 0;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[windowStart] > 60_000) windowStart++;
    maxBurst = Math.max(maxBurst, i - windowStart + 1);
  }
  return maxBurst;
}

function processNavigationGraph(navSignals) {
  if (navSignals.length === 0) return null;
  // Build most-common page sequence string and hash it (FNV-1a 32-bit)
  const sequences = navSignals
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt))
    .map(s => `${s.payload?.from_page || '?'}->${s.payload?.to_page || '?'}`)
    .join('|');
  // FNV-1a 32-bit hash
  let hash = 2166136261;
  for (let i = 0; i < Math.min(sequences.length, 200); i++) {
    hash ^= sequences.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
}

// ── Per-user vector computation ────────────────────────────────────────────────

async function computeVectorForUser(userId, windowStart, windowEnd) {
  const signals = await BehaviorSignal.find({
    userId,
    receivedAt: { $gte: windowStart, $lte: windowEnd },
  }).lean();

  if (signals.length === 0) return null;

  const byType = {};
  for (const s of signals) {
    if (!byType[s.signalType]) byType[s.signalType] = [];
    byType[s.signalType].push(s);
  }

  const typing = processTypingSignals(byType.typing_burst || []);

  return {
    loginIntervalEntropy:  processLoginIntervals(byType.session_start || []),
    typingVelocityMean:    typing.mean,
    typingVelocityStdDev:  typing.stdDev,
    clickIntervalCV:       processClickIntervals(byType.click_event || []),
    scrollPatternEntropy:  processScrollEntropy(byType.scroll_event || []),
    sessionDurationP50:    processSessionDurations(byType.session_end || []),
    postCadenceRegularity: processPostCadence(byType.post_created || []),
    referralBurstScore:    processReferralBurst(byType.referral_sent || []),
    navigationGraphHash:   processNavigationGraph(byType.navigation || []),
    windowStart,
    windowEnd,
    eventCount: signals.length,
    lastComputedAt: new Date(),
  };
}

// ── Main job ──────────────────────────────────────────────────────────────────

async function runVectorBuilderJob() {
  console.log('[vectorBuilderJob] Starting…');
  const startedAt = Date.now();

  const windowEnd   = new Date();
  const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Process in batches of 200 users to avoid memory spikes
  const BATCH = 200;
  let skip = 0;
  let processed = 0;
  let errors = 0;

  while (true) {
    const users = await User.find({})
      .select('_id')
      .skip(skip)
      .limit(BATCH)
      .lean();

    if (users.length === 0) break;

    await Promise.all(users.map(async (user) => {
      try {
        const data = await computeVectorForUser(user._id, windowStart, windowEnd);
        if (!data) return;  // No signals in window — skip

        await BehaviorVector.findOneAndUpdate(
          { userId: user._id },
          { $set: data },
          { upsert: true }
        );
        processed++;
      } catch (err) {
        console.error(`[vectorBuilderJob] Error for user ${user._id}:`, err.message);
        errors++;
      }
    }));

    skip += BATCH;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[vectorBuilderJob] Done. Processed: ${processed}, Errors: ${errors}, Time: ${elapsed}s`);
}

module.exports = { runVectorBuilderJob };