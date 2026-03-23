/**
 * intelligence/platformEventBus.js
 *
 * System 09 — Central Platform Event Bus
 *
 * A lightweight, zero-dependency event bus that runs inside the existing
 * Node.js/Express process. No Kafka required for local/dev — the same
 * interface can be swapped to a Kafka producer in production.
 *
 * HOW TO USE:
 *   const bus = require('./intelligence/platformEventBus');
 *   bus.emit(bus.EVENTS.USER_CREATED, { userId, ipAddress, deviceId, ... });
 *
 * All fraud, graph, moderation, and anomaly consumers auto-subscribe on boot.
 *
 * FIX: Added KYC_RESET to EVENTS so adminKycController can reference it via
 *   bus.EVENTS.KYC_RESET instead of falling back to a bare string literal.
 *   Previously bus.EVENTS.KYC_RESET was undefined, meaning the null-coalescing
 *   fallback `bus.EVENTS.KYC_RESET ?? 'kyc_reset'` always used the string —
 *   any listener that subscribed via bus.EVENTS.KYC_RESET would never fire.
 */

'use strict';

const EventEmitter = require('events');

class PlatformEventBus extends EventEmitter {
  constructor() {
    super();
    // Don't crash the server if a listener throws — log and continue
    this.setMaxListeners(50);
    this.on('error', (err) => {
      console.error('[EventBus] Unhandled error event:', err.message);
    });
  }

  /**
   * Emit a platform event with a standard envelope.
   * @param {string} eventType  - one of EVENTS.*
   * @param {object} payload    - event-specific data
   * @param {object} [meta]     - optional: { userId, sessionId, ipAddress, deviceId }
   */
  emit(eventType, payload = {}, meta = {}) {
    const envelope = {
      eventId:   require('crypto').randomUUID(),
      eventType,
      version:   '1.0',
      timestamp: new Date(),           // Date object — PlatformEvent schema uses Date type
      source:    'sosholife-api',
      userId:    meta.userId    || payload.userId    || null,
      sessionId: meta.sessionId || payload.sessionId || null,
      ipAddress: meta.ipAddress || payload.ipAddress || null,
      deviceId:  meta.deviceId  || payload.deviceId  || null,
      payload,
    };

    // Persist async — never block request
    this._persistEvent(envelope).catch(err =>
      console.error('[EventBus] persist failed:', err.message)
    );

    return super.emit(eventType, envelope);
  }

  /** Store event to MongoDB PlatformEvent collection for audit/ML */
  async _persistEvent(envelope) {
    try {
      // Lazy-require so the bus can be imported before Mongoose connects.
      // Mongoose will buffer the write until the connection is ready.
      const PlatformEvent = require('../models/PlatformEvent');
      await PlatformEvent.create(envelope);
    } catch (err) {
      // Non-fatal — bus still works for real-time listeners without DB
      if (err.name !== 'MongoServerError') {
        console.warn('[EventBus] Could not persist event:', err.message);
      }
    }
  }
}

// Singleton — shared across entire process
const bus = new PlatformEventBus();

// ── Event type constants ───────────────────────────────────────────────────────
bus.EVENTS = Object.freeze({
  // User lifecycle
  USER_CREATED:       'USER_CREATED',
  USER_BANNED:        'USER_BANNED',
  USER_DELETED:       'USER_DELETED',
  USER_LOGIN:         'USER_LOGIN',
  USER_LOGIN_FAILED:  'USER_LOGIN_FAILED',

  // Referral
  REFERRAL_CREATED: 'REFERRAL_CREATED',

  // Rewards
  REWARD_CLAIMED:  'REWARD_CLAIMED',
  REWARD_FROZEN:   'REWARD_FROZEN',
  REWARD_UNFROZEN: 'REWARD_UNFROZEN',

  // Content
  POST_CREATED:    'POST_CREATED',
  POST_FLAGGED:    'POST_FLAGGED',
  POST_REMOVED:    'POST_REMOVED',
  COMMENT_CREATED: 'COMMENT_CREATED',
  MESSAGE_SENT:    'MESSAGE_SENT',

  // Payments
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',

  // Admin
  ADMIN_ACTION:      'ADMIN_ACTION',
  FRAUD_DETECTED:    'FRAUD_DETECTED',
  ANOMALY_DETECTED:  'ANOMALY_DETECTED',

  // KYC
  KYC_REQUIRED:  'KYC_REQUIRED',
  KYC_SUBMITTED: 'KYC_SUBMITTED',
  KYC_VERIFIED:  'KYC_VERIFIED',
  KYC_REJECTED:  'KYC_REJECTED',
  KYC_RESET:     'KYC_RESET',     // FIX: was missing — caused null-coalescing fallback in adminKycController
});

module.exports = bus;