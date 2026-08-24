import mongoose from 'mongoose';
import { TICKET_STATUS, TICKET_CATEGORY } from '../utils/constants.js';

const TicketSchema = new mongoose.Schema({
  ticketNumber: { type: String, unique: true, index: true },
  raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  raisedByRole: { type: String, enum: ['family', 'nanny'] },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  category: { type: String, enum: Object.values(TICKET_CATEGORY), default: TICKET_CATEGORY.OTHER, index: true },
  subject: String,
  description: String,
  status: { type: String, enum: Object.values(TICKET_STATUS), default: TICKET_STATUS.OPEN, index: true },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  replies: [{
    from: { type: String, enum: ['user', 'admin'] },
    body: String,
    at: { type: Date, default: Date.now },
  }],
  resolvedAt: Date,
}, { timestamps: true });

export default mongoose.model('Ticket', TicketSchema);
