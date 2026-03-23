// services/deviceGraphUpdater.js
// Updates the device graph whenever a user performs a significant action.
// Call this service from authController (login/register),
// payment routes (subscription activate), and referral creation.
//
// Design principle: all writes are upserts — safe to call multiple times.
//
// FIXES:
//   1. CRITICAL — recordLogin referenced an undefined `user` variable and called
//      markClusterAsUntrusted() which does not exist anywhere in the codebase.
//      Both lines have been removed. KYC enforcement for reward gating belongs in
//      the reward claim routes (activity.js), not in the graph updater whose sole
//      job is recording connectivity — it has no access to the full user document.
//
//   2. CRITICAL — Broken Promise.all save logic. The original code called
//      .save() immediately while building the `saves` array, pushing the already-
//      resolved Promise (not the function). Then it tried to detect functions with
//      `typeof s === 'function'` but nothing was a function, so duplicated saves
//      for userNode happened silently while ipNode edges were sometimes dropped.
//      Fixed by collecting the Mongoose documents that need saving and calling
//      .save() on them inside Promise.all cleanly, guarding against double-saves
//      of userNode when both deviceNode and ipNode are present.

'use strict';

const DeviceGraph       = require('../models/DeviceGraph');
const DeviceFingerprint = require('../models/DeviceFingerprint');

/**
 * Record a login event in the device graph.
 * Creates/updates nodes for: user, device (optional), ip (optional).
 * Creates/updates edges between them.
 *
 * @param {string|ObjectId} userId
 * @param {string|null}     fpHash  Browser fingerprint hash (X-FP-Hash header), or null
 * @param {string|null}     ip      Request IP address, or null
 */
async function recordLogin(userId, fpHash, ip) {
  const userIdStr = String(userId);

  // ── Upsert graph nodes ───────────────────────────────────────────────────
  const [userNode, ipNode] = await Promise.all([
    DeviceGraph.findOneAndUpdate(
      { entityType: 'user', entityId: userIdStr },
      { $setOnInsert: { entityType: 'user', entityId: userIdStr } },
      { upsert: true, new: true }
    ),
    ip
      ? DeviceGraph.findOneAndUpdate(
          { entityType: 'ip', entityId: ip },
          { $setOnInsert: { entityType: 'ip', entityId: ip } },
          { upsert: true, new: true }
        )
      : Promise.resolve(null),
  ]);

  let deviceNode = null;
  if (fpHash) {
    deviceNode = await DeviceGraph.findOneAndUpdate(
      { entityType: 'device', entityId: fpHash },
      { $setOnInsert: { entityType: 'device', entityId: fpHash } },
      { upsert: true, new: true }
    );
  }

  // ── Add edges and collect nodes that need saving ─────────────────────────
  // Use a Map keyed by node._id string so userNode is never saved twice even
  // when both deviceNode and ipNode are present.
  const toSave = new Map();

  if (deviceNode) {
    userNode.addEdge('device', fpHash, 'login');
    deviceNode.addEdge('user', userIdStr, 'login');
    toSave.set(String(userNode._id), userNode);
    toSave.set(String(deviceNode._id), deviceNode);
  }

  if (ipNode) {
    userNode.addEdge('ip', ip, 'login');
    ipNode.addEdge('user', userIdStr, 'login');
    toSave.set(String(userNode._id), userNode);   // safe no-op if already present
    toSave.set(String(ipNode._id), ipNode);
  }

  if (toSave.size > 0) {
    await Promise.all([...toSave.values()].map(n => n.save()));
  }

  // ── Update DeviceFingerprint collection ──────────────────────────────────
  if (fpHash) {
    const fp = await DeviceFingerprint.findOneAndUpdate(
      { fpHash },
      {
        $addToSet:    { userIds: userId },
        $set:         { lastSeenAt: new Date() },
        $setOnInsert: { fpHash, firstSeenAt: new Date() },
      },
      { upsert: true, new: true }
    );
    if (fp) {
      fp.evaluateRisk();
      await fp.save();
    }
  }
}

/**
 * Record a referral relationship in the device graph.
 * Creates edge: referrer → referred and referred → referrer (relation: 'referral').
 *
 * @param {string|ObjectId} referrerId
 * @param {string|ObjectId} referredId
 */
async function recordReferral(referrerId, referredId) {
  const [referrerNode, referredNode] = await Promise.all([
    DeviceGraph.findOneAndUpdate(
      { entityType: 'user', entityId: String(referrerId) },
      { $setOnInsert: { entityType: 'user', entityId: String(referrerId) } },
      { upsert: true, new: true }
    ),
    DeviceGraph.findOneAndUpdate(
      { entityType: 'user', entityId: String(referredId) },
      { $setOnInsert: { entityType: 'user', entityId: String(referredId) } },
      { upsert: true, new: true }
    ),
  ]);

  referrerNode.addEdge('user', String(referredId), 'referral');
  referredNode.addEdge('user', String(referrerId), 'referral');

  await Promise.all([referrerNode.save(), referredNode.save()]);
}

/**
 * Record a payment account in the device graph.
 * Creates edge: user → payment (relation: 'payment').
 * Multiple users sharing the same Razorpay account is a fraud signal.
 *
 * @param {string|ObjectId} userId
 * @param {string}          razorpayPaymentId
 * @param {string}          [razorpayAccountId]
 */
async function recordPayment(userId, razorpayPaymentId, razorpayAccountId) {
  const userIdStr  = String(userId);
  const paymentKey = razorpayAccountId || razorpayPaymentId;

  const [userNode, paymentNode] = await Promise.all([
    DeviceGraph.findOneAndUpdate(
      { entityType: 'user', entityId: userIdStr },
      { $setOnInsert: { entityType: 'user', entityId: userIdStr } },
      { upsert: true, new: true }
    ),
    DeviceGraph.findOneAndUpdate(
      { entityType: 'payment', entityId: paymentKey },
      { $setOnInsert: { entityType: 'payment', entityId: paymentKey } },
      { upsert: true, new: true }
    ),
  ]);

  userNode.addEdge('payment', paymentKey, 'payment');
  paymentNode.addEdge('user', userIdStr, 'payment');

  await Promise.all([userNode.save(), paymentNode.save()]);
}

module.exports = { recordLogin, recordReferral, recordPayment };