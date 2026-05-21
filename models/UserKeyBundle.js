/**
 * models/UserKeyBundle.js
 *
 * Stores the server-side public keys for each user, used in the X3DH
 * (Extended Triple Diffie-Hellman) key agreement protocol.
 *
 * The server ONLY stores PUBLIC keys — private keys never leave the client.
 *
 * ── Key types (all encoded as base64 strings) ─────────────────────────────
 *
 *   identityKey (IK)
 *     Ed25519 public key. Long-lived identity key that ties a keypair to a
 *     specific SoShoLife account. Rotated only on account recovery / device
 *     re-registration. Signed by the platform server at registration to
 *     create a verifiable identity certificate.
 *
 *   signedPreKey (SPK)
 *     X25519 public key + Ed25519 signature over it (using IK private key).
 *     Rotated weekly. The signature lets recipients verify the SPK was
 *     published by the legitimate key owner, not a MITM server.
 *
 *   oneTimePreKeys (OPK)
 *     Array of single-use X25519 public keys. Consumed one per session
 *     initiation. Replenished by the client when the server reports the
 *     supply running low (< 5 remaining).  If all OPKs are exhausted, X3DH
 *     falls back to SPK-only mode (slightly weaker forward secrecy).
 *
 * ── Security properties ───────────────────────────────────────────────────
 *
 *   • Perfect Forward Secrecy (PFS): past sessions cannot be decrypted even
 *     if long-term keys are later compromised (OPK and SPK rotation).
 *   • Break-in recovery: the Double Ratchet (client-side) provides self-healing
 *     after a session key compromise.
 *   • Key verification: SPK is signed by IK, verifiable by recipients
 *     without trusting the server.
 *
 * ── Server role ───────────────────────────────────────────────────────────
 *
 *   The server is a "dumb" key store — it distributes public key bundles
 *   to senders but cannot perform decryption.  This is identical to Signal's
 *   server model.  The platform's inability to decrypt is the E2EE guarantee.
 */

'use strict';

const mongoose = require('mongoose');

// ── One-time pre-key sub-document ─────────────────────────────────────────
const OneTimePreKeySchema = new mongoose.Schema(
  {
    // Opaque key identifier (e.g. auto-incrementing int, or UUID)
    keyId:     { type: String, required: true },
    // X25519 public key (base64)
    publicKey: { type: String, required: true },
    // Set to true when consumed; purged on next maintenance sweep
    consumed:  { type: Boolean, default: false },
    consumedAt: { type: Date, default: null },
  },
  { _id: false }
);

// ── Signed pre-key sub-document ────────────────────────────────────────────
const SignedPreKeySchema = new mongoose.Schema(
  {
    keyId:     { type: String, required: true },
    publicKey: { type: String, required: true },
    // Ed25519 signature: Sign(IK_private, "SPK" || publicKey)
    signature: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main schema ────────────────────────────────────────────────────────────
const UserKeyBundleSchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'user',
      required: true,
      unique:   true,
      index:    true,
    },

    // ── Identity key ────────────────────────────────────────────────────────
    // Ed25519 public key (base64)
    identityKey: {
      type:     String,
      required: true,
    },
    // Platform-issued certificate: Sign(serverPrivKey, userId + identityKey + ts)
    // Lets recipients verify the IK is legitimately registered.
    identityCert: {
      type: String,
      default: null,
    },

    // ── Signed pre-key ───────────────────────────────────────────────────────
    signedPreKey: {
      type:     SignedPreKeySchema,
      required: true,
    },

    // ── One-time pre-keys ────────────────────────────────────────────────────
    oneTimePreKeys: {
      type:    [OneTimePreKeySchema],
      default: [],
    },

    // ── Metadata ─────────────────────────────────────────────────────────────
    // Timestamp of the last SPK rotation
    spkRotatedAt:  { type: Date, default: Date.now },
    // Number of remaining unconsumed OPKs (denormalised for fast threshold check)
    otpkCount:     { type: Number, default: 0 },
    // Client device fingerprint (for multi-device key management)
    deviceId:      { type: String, default: null },
    // Platform E2EE version this bundle was generated with
    protocolVersion: { type: String, default: 'x3dh-v1' },
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────────────────────
UserKeyBundleSchema.index({ user: 1, deviceId: 1 });
UserKeyBundleSchema.index({ 'oneTimePreKeys.consumed': 1, user: 1 });

// ── Methods ────────────────────────────────────────────────────────────────

/**
 * Consume the next available one-time pre-key.
 * Returns the consumed key object, or null if none remain.
 */
UserKeyBundleSchema.methods.consumeOTPK = async function () {
  const available = this.oneTimePreKeys.find(k => !k.consumed);
  if (!available) return null;

  available.consumed  = true;
  available.consumedAt = new Date();
  this.otpkCount = this.oneTimePreKeys.filter(k => !k.consumed).length;

  await this.save();
  return available;
};

/**
 * Returns a "key bundle" safe to send to a key-agreement initiator:
 *   { identityKey, identityCert, signedPreKey, oneTimePreKey? }
 * Does NOT include private keys (those never exist server-side).
 */
UserKeyBundleSchema.methods.toPublicBundle = async function () {
  const otpk = await this.consumeOTPK();
  return {
    userId:       this.user,
    identityKey:  this.identityKey,
    identityCert: this.identityCert,
    signedPreKey: {
      keyId:     this.signedPreKey.keyId,
      publicKey: this.signedPreKey.publicKey,
      signature: this.signedPreKey.signature,
    },
    oneTimePreKey: otpk
      ? { keyId: otpk.keyId, publicKey: otpk.publicKey }
      : null,
    protocolVersion: this.protocolVersion,
    otpkRemaining:   this.otpkCount,
  };
};

/**
 * Threshold below which the server tells the client to replenish OTPKs.
 */
UserKeyBundleSchema.statics.LOW_OTPK_THRESHOLD = 5;

module.exports = mongoose.model('UserKeyBundle', UserKeyBundleSchema);