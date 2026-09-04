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
