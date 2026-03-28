const mongoose = require('mongoose');
const { Schema } = mongoose;

const KycSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },

  submissionId: { type: String, unique: true, index: true },

  version: { type: Number, default: 1 },

  status: {
    type: String,
    enum: ['submitted', 'under_review', 'verified', 'rejected'],
    default: 'submitted',
    index: true,
  },

  documents: {
    aadhaar: { file: String, thumbnail: String },
    pan:     { file: String, thumbnail: String },
    bank:    { file: String, thumbnail: String },
    selfie:  { file: String, thumbnail: String },
  },

  ocrData: {
    aadhaar: Schema.Types.Mixed,
    pan: Schema.Types.Mixed,
  },

  scores: {
    overall: Number,
    faceMatch: Number,
    liveness: Number,
  },

  review: {
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'user' },
    reviewedAt: Date,
    notes: String,
    rejectionReason: String,
  },

  history: [{
    action: String,
    by: { type: Schema.Types.ObjectId, ref: 'user' },
    at: { type: Date, default: Date.now },
    meta: Schema.Types.Mixed,
  }],

  isLatest: { type: Boolean, default: true, index: true },

}, { timestamps: true });

KycSchema.pre('save', async function (next) {
  if (this.isNew) {
    const last = await mongoose.model('KYC')
      .findOne({ user: this.user })
      .sort({ version: -1 });

    this.version = last ? last.version + 1 : 1;

    await mongoose.model('KYC').updateMany(
      { user: this.user, isLatest: true },
      { isLatest: false }
    );
  }
  next();
});

module.exports = mongoose.model('KYC', KycSchema);