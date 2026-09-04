import mongoose from 'mongoose';

/**
 * Someone opened a referral link.
 *
 * Recorded before they message, so the funnel shows people who clicked and
 * never started a chat — otherwise a link that gets plenty of traffic but no
 * signups is indistinguishable from one nobody opened.
 */
const ReferralClickSchema = new mongoose.Schema({
  code: { type: String, index: true },
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  // Filled in later if a chat starts from this click.
  convertedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  convertedAt: Date,
  userAgent: String,
  ip: String,
}, { timestamps: true });

ReferralClickSchema.index({ createdAt: -1 });

export default mongoose.model('ReferralClick', ReferralClickSchema);
