import mongoose from 'mongoose';

/**
 * Relay chat between a family and a nanny. Phone numbers are never exposed:
 * messages are forwarded by the bot on each side.
 */
const MessageSchema = new mongoose.Schema({
  from: { type: String, enum: ['family', 'nanny', 'system', 'admin'] },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  body: String,
  mediaUrl: String,
  sentAt: { type: Date, default: Date.now },
  readAt: Date,
}, { _id: true });

const ChatThreadSchema = new mongoose.Schema({
  family: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  nanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
  messages: [MessageSchema],
  familyActive: { type: Boolean, default: false },
  nannyActive: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },
  lastMessageAt: Date,
}, { timestamps: true });

ChatThreadSchema.index({ family: 1, nanny: 1, booking: 1 });

export default mongoose.model('ChatThread', ChatThreadSchema);
