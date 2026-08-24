import mongoose from 'mongoose';

/** Audit trail of every inbound/outbound WhatsApp message. */
const MessageLogSchema = new mongoose.Schema({
  direction: { type: String, enum: ['in', 'out'], index: true },
  phone: { type: String, index: true },
  role: String,
  body: String,
  mediaUrl: String,
  state: String,
  providerId: String,
  error: String,
}, { timestamps: true });

MessageLogSchema.index({ createdAt: -1 });

export default mongoose.model('MessageLog', MessageLogSchema);
