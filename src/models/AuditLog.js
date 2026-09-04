import mongoose from 'mongoose';

/**
 * Who did what, and to whom.
 *
 * With several people sharing the dashboard, "the booking was cancelled" is
 * not enough — someone has to be able to answer who cancelled it, when, and
 * what it looked like beforehand. Written on every state-changing admin
 * action, so the record exists before anyone thinks to ask for it.
 *
 * Deliberately append-only: nothing in the app updates or deletes a row.
 */
const AuditLogSchema = new mongoose.Schema({
  // Who acted. Kept as a denormalised name/email too, so the trail still
  // reads correctly after an admin account is renamed or removed.
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', index: true },
  adminName: String,
  adminEmail: String,

  /** Verb, e.g. "payment.approve", "booking.cancel", "settings.update". */
  action: { type: String, required: true, index: true },

  /** What it happened to. */
  targetType: { type: String, index: true },   // booking | payment | user | setting | admin
  target: { type: mongoose.Schema.Types.ObjectId, index: true },
  targetLabel: String,                          // "#12345", an email, a nanny's name

  /**
   * What changed. Only the fields that moved, so a diff stays readable
   * months later without loading the whole document.
   */
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  note: String,

  ip: String,
  userAgent: String,
}, { timestamps: true });

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ targetType: 1, target: 1, createdAt: -1 });

export default mongoose.model('AuditLog', AuditLogSchema);
