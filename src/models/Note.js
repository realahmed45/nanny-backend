import mongoose from 'mongoose';

/**
 * A note an admin left on a booking, family or nanny.
 *
 * The system records what happened; a note records what someone decided to
 * do about it. Both are needed to pick up a case cold — "family called, angry
 * about the late arrival, offered a partial refund" is not derivable from any
 * status field.
 *
 * Attachments live here rather than in a separate store because a note and
 * its evidence are read together or not at all.
 */
const AttachmentSchema = new mongoose.Schema({
  url: { type: String, required: true },
  name: String,
  /** Broad kind, used to pick an icon: image | pdf | document | other. */
  kind: { type: String, default: 'other' },
  mimeType: String,
  sizeBytes: Number,
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const NoteSchema = new mongoose.Schema({
  targetType: { type: String, required: true, index: true },  // booking | family | nanny
  target: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  /**
   * A note about a person is either general or about one of their bookings.
   *
   * Held here rather than by retargeting the note at the booking, so it stays
   * on the person's profile either way: "she cancelled twice on #12391" belongs
   * in her history, not only inside a booking nobody will reopen. A note
   * written on the booking itself sets this to its own booking, so both views
   * agree about what a note is attached to.
   */
  bookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
  /** Denormalised so a note can name its booking without a second lookup. */
  bookingNumber: String,

  body: { type: String, required: true },
  attachments: [AttachmentSchema],

  // Who wrote it. The name is denormalised so the note still says who wrote
  // it after that admin leaves.
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', index: true },
  authorName: String,

  // Edits are recorded rather than silent, since a note is a record of a
  // decision and quietly rewriting one destroys its value as evidence.
  editedAt: Date,
  editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  editedByName: String,
}, { timestamps: true });

NoteSchema.index({ targetType: 1, target: 1, createdAt: -1 });

export default mongoose.model('Note', NoteSchema);
