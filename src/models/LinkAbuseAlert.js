import mongoose from 'mongoose';

/**
 * OR9. A pattern worth a human look.
 *
 * Nothing here blocks anything. The detectors raise a flag and a person
 * decides — an automatic block on a false positive costs a real referrer
 * their reward with no way to notice, which is worse than a reviewed alert.
 *
 * Never deleted; reviewing sets a status.
 */
export const ABUSE_KIND = {
  MASS_BLAST: 'mass_blast',              // many distinct numbers on one link, fast
  BURST: 'burst',                        // clicks closer together than a human can tap
  COLLUSION: 'collusion',                // one number on many links from one sharer
  CREDIT_SNIPING: 'credit_sniping',      // referrer swapped just before a first booking
  SELF_REFERRAL: 'self_referral',        // sharer's own number
  CONVERSION_TOO_HIGH: 'conversion_too_high',
  INSIDER_CLICK: 'insider_click',        // a nanny or staff number clicking
  RECYCLED_NUMBER: 'recycled_number',
  LINK_FLOOD: 'link_flood',              // one sharer minting links compulsively
};

const LinkAbuseAlertSchema = new mongoose.Schema({
  kind: { type: String, enum: Object.values(ABUSE_KIND), required: true, index: true },

  /** What the pattern is about — a link, a sharer, or a phone. */
  subjectType: { type: String, enum: ['link', 'sharer', 'phone'], required: true },
  subject: { type: String, required: true, index: true },

  /** The day it was seen, so one pattern raises one alert per day. */
  day: { type: String, required: true },

  severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  detail: String,
  evidence: mongoose.Schema.Types.Mixed,

  sharer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  status: { type: String, enum: ['open', 'reviewed', 'dismissed'], default: 'open', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  reviewedAt: Date,
  reviewNote: String,
}, { timestamps: true });

// One alert per pattern per day, rather than one per detection sweep.
LinkAbuseAlertSchema.index({ kind: 1, subject: 1, day: 1 }, { unique: true });
LinkAbuseAlertSchema.index({ createdAt: -1 });

export default mongoose.model('LinkAbuseAlert', LinkAbuseAlertSchema);
