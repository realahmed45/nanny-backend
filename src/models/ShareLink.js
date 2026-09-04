import mongoose from 'mongoose';

/**
 * One link, minted once, shared many times.
 *
 * A family's `referralCode` is permanent and identifies them; a ShareLink is
 * a dated claim on top of it. The distinction matters: the code says who is
 * sharing, the link says when they shared and for how long that share can
 * still earn them anything (OR5, OR6).
 *
 * Never deleted. A lapsed link becomes `expired` so reports stop counting it
 * as live without losing the history of what it did while it was.
 */
const ConversionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: String,
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  bookingNumber: String,
  amount: Number,
  at: { type: Date, default: Date.now },
}, { _id: true });

const ShareLinkSchema = new mongoose.Schema({
  /** The 22-character code in the URL. Not the sharer's referralCode. */
  linkId: { type: String, required: true, unique: true, index: true },

  sharer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  /** Denormalised so a report reads correctly if the account is renamed. */
  sharerCode: String,
  sharerPhone: String,

  /** What was shared: the platform generally, or one particular nanny. */
  kind: { type: String, enum: ['general', 'nanny'], default: 'general' },
  nanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  trackedUrl: String,
  waUrl: String,

  /**
   * OR5. Counted from creation, not from the click — a link handed out today
   * is dead in 30 days whether or not anyone ever opened it.
   */
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active', index: true },

  // OR6: unlimited use, so conversions is a list rather than a flag.
  conversions: [ConversionSchema],

  openCount: { type: Number, default: 0 },
  uniqueClickers: { type: Number, default: 0 },
}, { timestamps: true });

ShareLinkSchema.index({ sharer: 1, createdAt: -1 });
ShareLinkSchema.index({ status: 1, expiresAt: 1 });

/** Live means active and inside its window — both, every time it is asked. */
ShareLinkSchema.methods.isLive = function isLive(at = new Date()) {
  return this.status === 'active' && this.expiresAt > at;
};

export default mongoose.model('ShareLink', ShareLinkSchema);
