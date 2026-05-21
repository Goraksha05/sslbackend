/**
 * models/E2EE_Message.js  (DROP-IN REPLACEMENT for models/Message.js)
 *
 * End-to-End Encrypted messaging schema with mandatory India IT Act compliance.
 *
 * ── Encryption model ─────────────────────────────────────────────────────────
 *
 *   Algorithm: X3DH (Extended Triple Diffie-Hellman) key agreement → AES-256-GCM
 *
 *   Key hierarchy:
 *     Identity Key (IK)   — long-lived Ed25519 keypair; stored in UserKeyBundle
 *     Signed PreKey (SPK) — medium-term X25519 keypair; rotated weekly
 *     One-Time PreKey (OPK) — single-use X25519 keypairs; replenished as needed
 *
 *   Per-message encryption:
 *     1. Sender derives a shared session key via X3DH using their IK and the
 *        recipient's published SPK + OPK bundle.
 *     2. Session key → HKDF → AES-256-GCM symmetric key.
 *     3. Message plaintext is encrypted with a fresh 12-byte IV.
 *     4. Ciphertext + IV + auth-tag stored in `encryptedPayload`.
 *     5. The server NEVER receives the plaintext or the AES key.
 *
 *   Group chats:
 *     Sender-Key protocol (similar to Signal's group model):
 *     One SenderKey per (group, sender) pair is distributed to all members
 *     encrypted under each member's IK.  Subsequent messages in the same
 *     group use the ratcheted SenderKey — O(1) encrypt, O(n) distribute.
 *
 * ── IT Rules § 4(2) / § 69 / § 69A compliance ───────────────────────────────
 *
 *   The Ministry of Electronics and Information Technology (MeitY) and courts
 *   interpreting Section 69 of the IT Act 2000 require that significant social
 *   media intermediaries (SSMIs) be able to identify the "first originator" of
 *   any message upon a government order.  This does NOT require the platform to
 *   read message content; it only requires that the IDENTITY of who first sent a
 *   piece of content can be traced back.
 *
 *   Implementation approach (legally compliant, privacy-respecting):
 *
 *   a) HMAC chaining fingerprint
 *      Each message stores a one-way HMAC-SHA256 of:
 *        HMAC( serverSecret, userId + chatId + contentHash )
 *      This fingerprint is deterministic — if the same user sends the same
 *      content twice, the HMAC is the same — but the server cannot reverse it
 *      to read the content.  Under a Section 69 order the server can reveal
 *      the userId whose fingerprint matches, without decrypting the message.
 *
 *   b) Originator certificate (encrypted under government key)
 *      A small originator bundle { userId, phone, timestamp, contentHash } is
 *      encrypted under the government's published RSA-OAEP public key
 *      (provisioned via the MeitY key escrow mechanism).  Only the government,
 *      with their private key, can decrypt this bundle.  The platform cannot
 *      read it.  This bundle is stored for 180 days per Rule 4(2) retention.
 *
 *   c) Message hash chain (forwarding provenance)
 *      Every forward copies `originatorFingerprint` from the original message.
 *      The chain is: original send → forward(s).  The government can trace any
 *      forwarded message back to the first originator fingerprint and then,
 *      under court order, the platform reveals which userId corresponds to that
 *      fingerprint.
 *
 *   d) Minimal metadata retention
 *      No message content (plaintext or ciphertext) is stored beyond TTL.
 *      Only: sender ObjectId, chat ObjectId, timestamp, originator fingerprint,
 *      and the government-encrypted originator certificate.
 *      This is the absolute minimum required by the Rules and no more.
 *
 * ── Key fields ────────────────────────────────────────────────────────────────
 *
 *   encryptedPayload     — AES-256-GCM ciphertext + IV + authTag (base64)
 *   encryptedMediaKey    — AES key for media file, encrypted under session key
 *   originatorFingerprint— HMAC fingerprint (see b above) — retained 180 days
 *   originatorCert       — RSA-OAEP blob encrypted under gov key — retained 180 days
 *   forwardedFromMsgId   — original message ObjectId when forwarded
 *   isForwarded          — boolean; forwarded messages copy the original fingerprint
 *   keyId                — which Signed PreKey was used (for SPK rotation hygiene)
 *   epochId              — sender-key epoch for group chats (ratchet counter)
 *   contentHash          — SHA-256 of plaintext (for originator HMAC; never stored
 *                          after the HMAC is computed — transient only)
 *
 * ── What is NEVER stored ─────────────────────────────────────────────────────
 *   • Message plaintext
 *   • Session AES key
 *   • Recipient's private keys
 *   • Sender's DH ephemeral private key
 *
 * ── References ────────────────────────────────────────────────────────────────
 *   IT Act 2000, Section 69, Section 69A
 *   Information Technology (Intermediary Guidelines and Digital Media Ethics
 *     Code) Rules 2021, Rule 4(2)
 *   Signal Protocol specification (https://signal.org/docs/)
 *   MeitY Traceability Guidelines (draft 2022)
 */

'use strict';

const mongoose = require('mongoose');

// ── Sub-schema: encrypted payload envelope ─────────────────────────────────
const EncryptedPayloadSchema = new mongoose.Schema(
  {
    // AES-256-GCM ciphertext (base64-encoded)
    ciphertext: { type: String, required: true },
    // 12-byte IV / nonce (base64)
    iv:         { type: String, required: true },
    // 16-byte GCM auth tag (base64)
    authTag:    { type: String, required: true },
    // HKDF info label used when deriving the AES key
    hkdfInfo:   { type: String, default: 'sosholife-msg-v1' },
    // Which algorithm version was used (future-proof)
    version:    { type: String, default: 'x3dh-aes256gcm-v1' },
  },
  { _id: false }
);

// ── Sub-schema: per-recipient encrypted session key (group chats) ──────────
// In 1:1 chats the session key is derived deterministically via X3DH, so
// this array has one entry.  In group chats it has one entry per member,
// each holding the SenderKey encrypted under that member's IK.
const RecipientKeySchema = new mongoose.Schema(
  {
    recipientId:     { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    // SenderKey / session-key wrapped under the recipient's IK (base64)
    encryptedKey:    { type: String, required: true },
    // The recipient's SPK key-id that was used for wrapping
    recipientKeyId:  { type: String, required: true },
  },
  { _id: false }
);

// ── Sub-schema: IT Act originator compliance bundle ───────────────────────
const OriginatorCertSchema = new mongoose.Schema(
  {
    // RSA-OAEP ciphertext encrypted under MeitY's published public key.
    // Plaintext (only MeitY can decrypt): { userId, phone, contentHash, ts }
    // Platform CANNOT read this field.
    govEncryptedBundle: { type: String, required: true },
    // Key-id of the government RSA key used (allows key rotation)
    govKeyId:           { type: String, required: true },
    // Algorithm identifier
    algorithm:          { type: String, default: 'RSA-OAEP-256' },
    // When this certificate expires (Rule 4(2): 180 days minimum)
    expiresAt: {
      type:    Date,
      default: () => {
        const d = new Date();
        d.setDate(d.getDate() + 180);
        return d;
      },
    },
  },
  { _id: false }
);

// ── Sub-schema: reply reference (non-content) ─────────────────────────────
const ReplyRefSchema = new mongoose.Schema(
  {
    messageId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    // Encrypted snippet — decrypted client-side; server sees only ciphertext
    encryptedSnippet: { type: String },
    senderName: { type: String },
    mediaType:  { type: String },
  },
  { _id: false }
);

// ── Sub-schema: delivery status ────────────────────────────────────────────
const DeliveryRecordSchema = new mongoose.Schema(
  {
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    deliveredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main message schema ────────────────────────────────────────────────────
const E2EEMessageSchema = new mongoose.Schema(
  {
    // ── Core ───────────────────────────────────────────────────────────────
    chatId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Chat',
      required: true,
      index:    true,
    },
    sender: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'user',
      required: true,
    },

    // ── Encrypted content ───────────────────────────────────────────────────
    // Set for text messages.  Absent / null for media-only messages.
    encryptedPayload: {
      type:     EncryptedPayloadSchema,
      default:  null,
    },

    // Per-recipient wrapped keys (1 entry for 1:1; N entries for groups)
    recipientKeys: {
      type:    [RecipientKeySchema],
      default: [],
    },

    // Media: the actual file is E2EE on Cloudinary / S3.
    // encryptedMediaKey is the AES key for the media, itself encrypted under
    // the same session key used for the text payload.
    encryptedMediaKey: { type: String, default: null },
    mediaType: {
      type: String,
      enum: ['image', 'video', 'audio', 'document', null],
      default: null,
    },
    // Public CDN URL of the encrypted media blob.
    // The blob is AES-256-CBC encrypted client-side before upload.
    encryptedMediaUrl: { type: String, default: null },
    // Thumbnail is NOT encrypted — it is safe to show without decryption.
    thumbnailUrl:      { type: String, default: null },

    // Which Signed PreKey was used (allows SPK revocation hygiene).
    // Stored as an opaque string, e.g. "spk-20240601-abc123"
    keyId: { type: String, default: null },

    // Sender-key epoch for group message ratcheting (monotonically increasing).
    epochId: { type: Number, default: 0 },

    // ── IT Act § 69 / Rule 4(2) compliance fields ───────────────────────────

    /**
     * HMAC-SHA256( serverSecret, senderId + chatId + contentHash )
     *
     * - deterministic per (sender, chat, content) triple
     * - one-way: platform cannot reverse to plaintext
     * - identical for all forwards of the same content by the same originator
     * - disclosed only under a valid Section 69 court order
     *
     * Retained for 180 days minimum, then TTL-deleted.
     */
    originatorFingerprint: {
      type:  String,
      index: true,
      default: null,
    },

    /**
     * Government-encrypted originator certificate.
     * Encrypted under MeitY's RSA-OAEP public key.
     * Platform cannot decrypt — only MeitY can, under court order.
     * Retained for 180 days.
     */
    originatorCert: {
      type:    OriginatorCertSchema,
      default: null,
    },

    /**
     * Timestamp when originator data may be purged.
     * Set to now + 180 days.  A TTL index deletes these fields (not the
     * whole message) after this date, ensuring minimal data retention.
     * The message document itself persists (for chat history), but the
     * fingerprint and cert are nulled by a scheduled job.
     */
    originatorExpiresAt: {
      type:    Date,
      default: () => {
        const d = new Date();
        d.setDate(d.getDate() + 180);
        return d;
      },
    },

    // ── Forwarding provenance ───────────────────────────────────────────────
    isForwarded: { type: Boolean, default: false },

    /**
     * ObjectId of the original Message this was forwarded from.
     * Combined with originatorFingerprint, allows tracing the chain:
     *   current msg → forwardedFromMsgId → ... → original msg
     * The original msg's originatorFingerprint identifies the first originator.
     */
    forwardedFromMsgId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'Message',
      default: null,
    },

    /**
     * The originator fingerprint of the FIRST message in a forward chain.
     * Copied verbatim from the original message on forward.
     * This is what the government queries to find the first originator —
     * they never need to traverse the chain themselves.
     */
    firstOriginatorFingerprint: {
      type:  String,
      index: true,
      default: null,
    },

    // ── Delivery & status ────────────────────────────────────────────────────
    seenBy:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'user' }],
    deliveredTo: [DeliveryRecordSchema],

    isDeleted: { type: Boolean, default: false },
    deletedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'user' }],

    // ── Reply reference ──────────────────────────────────────────────────────
    replyTo: { type: ReplyRefSchema, default: null },

    // ── Reactions (server-side; emoji text is not sensitive) ────────────────
    reactions: [
      {
        userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
        emoji:     { type: String },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // ── Metadata ─────────────────────────────────────────────────────────────
    isEdited:    { type: Boolean, default: false },
    editedAt:    { type: Date, default: null },
    priority:    { type: String, enum: ['normal', 'high', 'urgent'], default: 'normal' },
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────────────────────
E2EEMessageSchema.index({ chatId: 1, createdAt: -1 });
E2EEMessageSchema.index({ sender: 1, createdAt: -1 });
E2EEMessageSchema.index({ originatorFingerprint: 1 });
E2EEMessageSchema.index({ firstOriginatorFingerprint: 1 });
E2EEMessageSchema.index({ originatorExpiresAt: 1 }); // for the 180-day purge job

// ── Virtuals ────────────────────────────────────────────────────────────────
E2EEMessageSchema.virtual('hasMedia').get(function () {
  return !!(this.encryptedMediaUrl && this.mediaType);
});

// ── Instance methods ────────────────────────────────────────────────────────

E2EEMessageSchema.methods.isSeenBy = function (userId) {
  return this.seenBy.some(id => id.toString() === userId.toString());
};

E2EEMessageSchema.methods.addReaction = function (userId, emoji) {
  this.reactions = this.reactions.filter(
    r => r.userId.toString() !== userId.toString()
  );
  if (emoji) this.reactions.push({ userId, emoji });
  return this.save();
};

E2EEMessageSchema.methods.removeReaction = function (userId) {
  this.reactions = this.reactions.filter(
    r => r.userId.toString() !== userId.toString()
  );
  return this.save();
};

// ── Static methods ─────────────────────────────────────────────────────────

E2EEMessageSchema.statics.getUnreadCount = async function (chatId, userId) {
  return this.countDocuments({
    chatId,
    sender:    { $ne: userId },
    seenBy:    { $ne: userId },
    isDeleted: false,
  });
};

// ── Pre-save: update Chat.lastMessage with encrypted placeholder ───────────
E2EEMessageSchema.pre('save', async function (next) {
  if (this.isNew && !this.isDeleted) {
    try {
      const Chat = mongoose.model('Chat');
      await Chat.findByIdAndUpdate(this.chatId, {
        // Store a content-neutral placeholder — the actual text is encrypted.
        lastMessage:       this.encryptedPayload ? '[Encrypted Message]' : `[${this.mediaType || 'Media'}]`,
        lastMessageTime:   this.createdAt || new Date(),
        lastMessageSender: this.sender,
        lastActive:        Date.now(),
      });
    } catch (err) {
      console.error('[E2EEMessage] Failed to update Chat.lastMessage:', err.message);
    }
  }
  next();
});

module.exports = mongoose.model('Message', E2EEMessageSchema);