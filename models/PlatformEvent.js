/**
 * models/PlatformEvent.js
 *
 * Immutable audit log for every event emitted through PlatformEventBus.
 * Used for:
 *   - Full audit trail of platform activity
 *   - ML feature replay (behaviour analysis, fraud pattern training)
 *   - Debugging event flows across services
 *
 * Documents are append-only. Never update or delete individual events.
 * TTL index auto-purges events older than 90 days to control storage.
 *
 * Schema mirrors the envelope shape built in PlatformEventBus.emit():
 *   { eventId, eventType, version, timestamp, source,
 *     userId, sessionId, ipAddress, deviceId, payload }
 */

'use strict';

const mongoose = require('mongoose');

const PlatformEventSchema = new mongoose.Schema(
  {
    // ── Envelope fields (set by PlatformEventBus) ────────────────────────────

    /** UUID v4 — unique per emission, used for idempotency checks */
    eventId: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },

    /** One of the constants in bus.EVENTS, e.g. 'USER_CREATED', 'KYC_VERIFIED' */
    eventType: {
      type:     String,
      required: true,
      index:    true,
    },

    /** Schema version string — bump when payload shape changes */
    version: {
      type:    String,
      default: '1.0',
    },

    /** ISO 8601 timestamp at point of emission (server clock) */
    timestamp: {
      type:     Date,
      required: true,
      index:    true,
    },

    /** Originating service identifier, e.g. 'sosholife-api' */
    source: {
      type:    String,
      default: 'sosholife-api',
    },

    // ── Context fields (extracted from envelope for fast querying) ───────────

    /** MongoDB ObjectId of the user this event concerns (if any) */
    userId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'user',
      default: null,
      index:   true,
    },

    /** Browser/SDK session UUID (not a DB id — not a ref) */
    sessionId: {
      type:    String,
      default: null,
    },

    /** Client IP address at time of event */
    ipAddress: {
      type:    String,
      default: null,
    },

    /** Device fingerprint hash (links to DeviceFingerprint.fpHash) */
    deviceId: {
      type:    String,
      default: null,
      index:   true,
    },

    // ── Event-specific payload ────────────────────────────────────────────────

    /**
     * Arbitrary JSON payload specific to the event type.
     * Kept as Mixed so any event shape can be stored without schema changes.
     * Consumers should validate payload shape based on eventType.
     */
    payload: {
      type:    mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    // No automatic timestamps — we use our own `timestamp` field so that
    // the stored time reflects when the event was *emitted*, not when the
    // DB write completed (these can differ under load).
    timestamps: false,
    versionKey: false,

    // Optimise for append-only workload: disable buffering so writes fail
    // fast if the connection is down rather than queueing indefinitely.
    bufferCommands: false,
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────

// Primary query patterns:
//   "all events for user X" — admin investigation panel, fraud review
PlatformEventSchema.index({ userId: 1, timestamp: -1 });

//   "all events of type Y in last N hours" — alerting, dashboards
PlatformEventSchema.index({ eventType: 1, timestamp: -1 });

//   "all events from device D" — multi-account detection
PlatformEventSchema.index({ deviceId: 1, timestamp: -1 });

// TTL: auto-purge events older than 90 days.
// Adjust expireAfterSeconds to match your data-retention policy.
// Note: TTL jobs run once per minute, so deletion is approximate.
PlatformEventSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_90d' }
);

module.exports = mongoose.model('PlatformEvent', PlatformEventSchema);