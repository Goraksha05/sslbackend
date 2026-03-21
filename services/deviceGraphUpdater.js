// services/deviceGraphUpdater.js
// Updates the device graph whenever a user performs a significant action.
// Call this service from authController (login/register),
// payment routes (subscription activate), and referral creation.
//
// Design principle: all writes are upserts — safe to call multiple times.
'use strict';

const DeviceGraph = require('../models/DeviceGraph');
const DeviceFingerprint = require('../models/DeviceFingerprint');

/**
 * Record a login event in the device graph.
 * Creates/updates nodes for: user, device, ip
 * Creates/updates edges between them.
 *
 * @param {string} userId
 * @param {string} fpHash  Browser fingerprint hash (from request header X-FP-Hash)
 * @param {string} ip      Request IP
 */
async function recordLogin(userId, fpHash, ip) {
  // 🔐 KYC VERIFICATION (CRITICAL)
  if (user.kyc.status !== 'verified') {
    markClusterAsUntrusted()
  }

  const userIdStr = String(userId);

  // Upsert all three nodes
  const [userNode, ipNode] = await Promise.all([
    DeviceGraph.findOneAndUpdate(
      { entityType: 'user', entityId: userIdStr },
      { $setOnInsert: { entityType: 'user', entityId: userIdStr } },
      { upsert: true, new: true }
    ),
    ip ? DeviceGraph.findOneAndUpdate(
      { entityType: 'ip', entityId: ip },
      { $setOnInsert: { entityType: 'ip', entityId: ip } },
      { upsert: true, new: true }
    ) : null,
  ]);

  let deviceNode = null;
  if (fpHash) {
    deviceNode = await DeviceGraph.findOneAndUpdate(
      { entityType: 'device', entityId: fpHash },
      { $setOnInsert: { entityType: 'device', entityId: fpHash } },
      { upsert: true, new: true }
    );
  }

  // Add edges: user → device, user → ip, device → user, ip → user
  const saves = [];

  if (deviceNode) {
    userNode.addEdge('device', fpHash, 'login');
    deviceNode.addEdge('user', userIdStr, 'login');
    saves.push(userNode.save(), deviceNode.save());
  }

  if (ipNode) {
    userNode.addEdge('ip', ip, 'login');
    ipNode.addEdge('user', userIdStr, 'login');
    if (!saves.includes(userNode.save)) saves.push(userNode.save());
    saves.push(ipNode.save());
  }

  await Promise.all(saves.map(s => (typeof s === 'function' ? s() : s)));

  // Also update DeviceFingerprint collection
  if (fpHash) {
    await DeviceFingerprint.findOneAndUpdate(
      { fpHash },
      {
        $addToSet: { userIds: userId },
        $set: { lastSeenAt: new Date() },
        $setOnInsert: { fpHash, firstSeenAt: new Date() },
      },
      { upsert: true, new: true }
    ).then(fp => {
      if (fp) {
        fp.evaluateRisk();
        return fp.save();
      }
    });
  }
}

/**
 * Record a referral relationship in the device graph.
 * Creates edge: referrer → referred (relation: 'referral')
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
 * Creates edge: user → payment (relation: 'payment')
 * Multiple users sharing the same Razorpay account = fraud signal.
 */
async function recordPayment(userId, razorpayPaymentId, razorpayAccountId) {
  const userIdStr = String(userId);

  const [userNode, paymentNode] = await Promise.all([
    DeviceGraph.findOneAndUpdate(
      { entityType: 'user', entityId: userIdStr },
      { $setOnInsert: { entityType: 'user', entityId: userIdStr } },
      { upsert: true, new: true }
    ),
    DeviceGraph.findOneAndUpdate(
      { entityType: 'payment', entityId: razorpayAccountId || razorpayPaymentId },
      { $setOnInsert: { entityType: 'payment', entityId: razorpayAccountId || razorpayPaymentId } },
      { upsert: true, new: true }
    ),
  ]);

  userNode.addEdge('payment', razorpayAccountId || razorpayPaymentId, 'payment');
  paymentNode.addEdge('user', userIdStr, 'payment');

  await Promise.all([userNode.save(), paymentNode.save()]);
}

module.exports = { recordLogin, recordReferral, recordPayment };