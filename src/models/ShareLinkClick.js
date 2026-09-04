import mongoose from 'mongoose';

/**
 * One row per click. Never de-duplicated, never deleted.
 *
 * The click stream is the only place that can show someone who tapped a link
 * and walked away — a link with plenty of traffic and no signups is otherwise
 * indistinguishable from one nobody opened.
 */

/**
 * Why this click won nothing.
 *
 * Blank means "this one won". It deliberately does not double as "no idea":
 * when it did, a frozen click and a never-replied click looked identical, and
 * frozen clicks are the most honest signal here — nobody games a click that
 * cannot earn anything.
 */
export const SKIP_REASON = {
  WON: '',                             // credited this click
  NO_INTERACTION: 'no_interaction',    // tapped, never wrote to us (OR4)
  OUTSIDE_WINDOW: 'outside_window',    // the link had lapsed (OR5)
  FROZEN: 'frozen',                    // already attributed for good (OR10)
  SELF_CLICK: 'self_click',            // the sharer tapped their own link
  SUPERSEDED: 'superseded',            // a later click took the claim (OR3)
  ALREADY_CREDITED: 'already_credited',
};

const ShareLinkClickSchema = new mongoose.Schema({
  linkId: { type: String, required: true, index: true },
  shareLink: { type: mongoose.Schema.Types.ObjectId, ref: 'ShareLink', index: true },
  sharer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  /**
   * OR1. Empty on a redirect row: the number is not knowable until they
   * write to us, and the row is adopted then rather than duplicated.
   */
  clickerPhone: { type: String, default: '', index: true },
  clicker: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  source: { type: String, enum: ['web_redirect', 'inbound_message', 'manual'], default: 'web_redirect' },

  /**
   * How sure we are this click belongs to this person. A redirect row starts
   * `none` and becomes `certain` when a coded message adopts it.
   */
  matchConfidence: { type: String, enum: ['none', 'inferred', 'certain'], default: 'none' },

  /** They wrote to us — OR4's moment. */
  becameInteraction: { type: Boolean, default: false },
  confirmedByMessageAt: Date,

  skipReason: { type: String, default: SKIP_REASON.NO_INTERACTION },

  /** One human tap can fire twice; this counts taps, not rows. */
  openCount: { type: Number, default: 1 },

  userAgent: String,
  ip: String,
}, { timestamps: true });

// The six the engine actually queries on.
ShareLinkClickSchema.index({ createdAt: -1 });
ShareLinkClickSchema.index({ linkId: 1, createdAt: -1 });
ShareLinkClickSchema.index({ clickerPhone: 1, createdAt: -1 });
ShareLinkClickSchema.index({ sharer: 1, createdAt: -1 });
ShareLinkClickSchema.index({ skipReason: 1, createdAt: -1 });
ShareLinkClickSchema.index({ becameInteraction: 1, createdAt: -1 });

export default mongoose.model('ShareLinkClick', ShareLinkClickSchema);
