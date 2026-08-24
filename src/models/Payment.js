import mongoose from 'mongoose';
import { PAYMENT_STATUS, PAYOUT_STATUS } from '../utils/constants.js';

/** Money moving from a family in (charge/refund). */
const PaymentSchema = new mongoose.Schema({
  reference: { type: String, unique: true, index: true },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
  family: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  kind: { type: String, enum: ['booking', 'additional', 'refund', 'penalty'], default: 'booking' },
  method: { type: String, enum: ['credit_card', 'bank_transfer', 'wallet', 'system'], default: 'credit_card' },
  amount: Number,
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.IN_PROCESS, index: true },
  providerRef: String,
  failureReason: String,
  breakdown: mongoose.Schema.Types.Mixed,
  processedAt: Date,
}, { timestamps: true });

/** Money moving out to a nanny. Spec: payouts are released every Monday. */
const PayoutSchema = new mongoose.Schema({
  reference: { type: String, unique: true, index: true },
  nanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
  serviceDayIds: [String],
  amount: Number,
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: Object.values(PAYOUT_STATUS), default: PAYOUT_STATUS.PENDING, index: true },
  scheduledFor: Date,
  releasedAt: Date,
  isFinalForBooking: { type: Boolean, default: false },
  failureReason: String,
  notes: String,
}, { timestamps: true });

export const Payment = mongoose.model('Payment', PaymentSchema);
export const Payout = mongoose.model('Payout', PayoutSchema);
export default Payment;
