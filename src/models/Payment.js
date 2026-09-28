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
  kind: {
    type: String,
    enum: ['earnings', 'special', 'advance'],
    default: 'earnings',
    index: true,
  },

  /**
   * An advance: money paid before her salary date, recovered from it.
   *
   * Not a cost to the business and not a gift — it is her own salary, early.
   * So it is tracked until it is recovered rather than simply recorded, and
   * `recoveredAt` is what separates an outstanding advance from a settled one.
   *
   * When an advance is larger than she earns that month her salary goes to
   * zero and the rest carries forward: nothing is clawed back from somebody
   * who has already spent it, and the balance stays visible against her name
   * until it clears.
   */
  advance: {
    /** What is still to come off her salary. Falls as it is recovered. */
    outstanding: { type: Number, default: 0 },
    /** The month it is meant to be taken from, as YYYY-MM. */
    recoverFrom: String,
    recoveredAt: Date,
  },

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

  /**
   * How much of this payout went to clearing an advance she had already had.
   *
   * Recorded so a smaller-than-expected payment can be explained rather than
   * argued about: the amount she is sent is what is left after this.
   */
  advanceRecovered: { type: Number, default: 0 },

  failureReason: String,
  notes: String,

  /**
   * When the reason/note and proof photo on this payout were wiped.
   *
   * Applies to advances only. The reason a nanny needed money early — a
   * family emergency, a medical bill — is personal, and there is no reason
   * for it to sit in the database forever once the month it was drawn
   * against has closed. The advance itself (amount, date, who) stays; only
   * the personal detail is cleared.
   */
  redactedAt: Date,
}, { timestamps: true });

export const Payment = mongoose.model('Payment', PaymentSchema);
export const Payout = mongoose.model('Payout', PayoutSchema);
export default Payment;
