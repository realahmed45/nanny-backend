import mongoose from 'mongoose';
import config from '../config/index.js';
import { PAYMENT_STATUS, PAYOUT_STATUS } from '../utils/constants.js';

/** Money moving from a family in (charge/refund). */
const PaymentSchema = new mongoose.Schema({
  reference: { type: String, unique: true, index: true },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
  family: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  kind: { type: String, enum: ['booking', 'additional', 'refund', 'penalty'], default: 'booking' },
  method: { type: String, enum: ['bank_transfer', 'system'], default: 'bank_transfer' },
  amount: Number,
  currency: { type: String, default: () => config.currency },
  status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.IN_PROCESS, index: true },

  // Money moves by manual bank transfer, so the record of truth is the proof
  // the family uploads plus an admin's decision on it.
  proof: {
    url: String,             // hosted image of the transfer receipt
    mediaId: String,
    uploadedAt: Date,
    note: String,            // anything the family typed with the screenshot
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  reviewedAt: Date,
  reviewNote: String,        // admin's reason, shown to the family on rejection

  // For refunds: proof the admin sent the money back.
  refundProof: {
    url: String,
    mediaId: String,
    uploadedAt: Date,
  },

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
  currency: { type: String, default: () => config.currency },
  status: { type: String, enum: Object.values(PAYOUT_STATUS), default: PAYOUT_STATUS.PENDING, index: true },
  scheduledFor: Date,
  releasedAt: Date,
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  isFinalForBooking: { type: Boolean, default: false },

  /**
   * What this payout is for.
   *
   * Most are earnings from service days. A `special` payout is everything
   * else the business owes her — a taxi fare she covered, a uniform, a
   * medical cost — and those need a reason and a receipt, because unlike
   * earnings there is no booking behind them to check the figure against.
   */
  kind: { type: String, enum: ['earnings', 'special'], default: 'earnings', index: true },

  /**
   * Why a special payout was raised, and the receipt for it.
   *
   * Required for `special` and meaningless for earnings. The receipt is the
   * evidence that the cost happened at all; the note is what it was for. A
   * payment to a person with neither is indistinguishable from an error.
   */
  reason: String,
  costProof: {
    url: String,
    uploadedAt: Date,
  },

  /**
   * Proof the money actually reached her.
   *
   * Separate from `costProof` and not interchangeable: one shows the expense
   * was real, the other shows we settled it. A dispute about whether she was
   * paid is answered by this one.
   */
  proof: {
    url: String,
    mediaId: String,
    uploadedAt: Date,
  },

  failureReason: String,
  notes: String,
}, { timestamps: true });

export const Payment = mongoose.model('Payment', PaymentSchema);
export const Payout = mongoose.model('Payout', PayoutSchema);
export default Payment;
