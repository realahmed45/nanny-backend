import mongoose from 'mongoose';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS,
  PAYMENT_STATUS, CANCELLED_BY, CPR_REQUIREMENT,
} from '../utils/constants.js';

/** One dated service within a booking. Multi-day bookings hold many of these. */
const ServiceDaySchema = new mongoose.Schema({
  date: { type: String, required: true },       // "YYYY-MM-DD"
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  hours: Number,
  amount: Number,                                // family-side value of this day
  // Set only on days priced away from the standard rate (a Nyepi eve, a
  // public holiday), so an unusual line on an invoice can be explained.
  rateMultiplier: Number,
  rateLabel: String,
  status: { type: String, enum: Object.values(SERVICE_DAY_STATUS), default: SERVICE_DAY_STATUS.SCHEDULED },

  arrivalOtp: String,
  arrivalConfirmedAt: Date,
  endOtp: String,
  endConfirmedAt: Date,

  overtimeMinutes: { type: Number, default: 0 },
  overtimeHours: { type: Number, default: 0 },
  overtimeAmount: { type: Number, default: 0 },

  nanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // may differ after replacement
  rescheduledFrom: String,
  cancelledAt: Date,
  refundAmount: { type: Number, default: 0 },
  nannyCompensation: { type: Number, default: 0 },
}, { _id: true });

/** Snapshot of the family's requirements; used for matching + re-matching. */
const RequirementsSchema = new mongoose.Schema({
  languages: [String],
  skills: [String],
  subjects: [String],
  budgetMin: Number,
  budgetMax: Number,
  cpr: { type: String, enum: Object.values(CPR_REQUIREMENT), default: CPR_REQUIREMENT.EITHER },
}, { _id: false });

const ChildSnapshotSchema = new mongoose.Schema({
  name: String, age: String, medicalNotes: String, dietaryNotes: String,
}, { _id: false });

const NannyResponseSchema = new mongoose.Schema({
  nanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  kind: { type: String, enum: ['new_booking', 'booking_change'] },
  sentAt: Date,
  expiresAt: Date,                 // sentAt + 1h (new) or + 2h (change)
  respondedAt: Date,
  outcome: { type: String, enum: ['accepted', 'declined', 'timed_out', 'pending'], default: 'pending' },
  declineReason: String,
}, { _id: true });

const BookingSchema = new mongoose.Schema({
  bookingNumber: { type: String, unique: true, index: true },
  family: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  nanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  status: { type: String, enum: Object.values(BOOKING_STATUS), default: BOOKING_STATUS.DRAFT, index: true },
  subStatus: { type: String, enum: Object.values(BOOKING_SUBSTATUS) },

  isMultiDay: { type: Boolean, default: false },
  startDate: String,                 // "YYYY-MM-DD"
  endDate: String,
  startTime: String,                 // "09:00"
  hoursPerDay: Number,
  repeatDays: [String],              // weekday names for recurring bookings
  serviceDays: [ServiceDaySchema],

  address: {
    label: String,
    mapUrl: String,
    addressLine: String,
  },

  requirements: { type: RequirementsSchema, default: () => ({}) },
  children: [ChildSnapshotSchema],
  otherInstructions: String,
  agentCallRequested: { type: Boolean, default: false },
  // Same-day request the family flagged as urgent.
  isEmergency: { type: Boolean, default: false },

  hourlyRate: Number,                // locked at booking time; nanny rate changes don't apply
  totalAmount: Number,
  // What the same booking would have cost without a referral discount,
  // and whether one was applied. Recorded so support can explain a price
  // months later without having to recompute it from settings that moved.
  standardHourlyRate: Number,
  referralDiscountApplied: { type: Boolean, default: false },
  paidAmount: { type: Number, default: 0 },
  additionalDue: { type: Number, default: 0 },
  refundDue: { type: Number, default: 0 },        // owed per policy
  refundedAmount: { type: Number, default: 0 },   // actually transferred back
  transportFee: { type: Number, default: 0 },
  paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.IN_PROCESS },

  nannyResponses: [NannyResponseSchema],
  rejectedNannies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  replacementOfNanny: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  rescheduleCount: { type: Number, default: 0 },
  pendingChange: { type: mongoose.Schema.Types.Mixed },   // proposed edits awaiting nanny approval

  liveLocation: {
    familySharing: { type: Boolean, default: false },
    nannySharing: { type: Boolean, default: false },
    lastNannyLocation: String,
    updatedAt: Date,
  },

  cancelledBy: { type: String, enum: Object.values(CANCELLED_BY) },
  cancelledAt: Date,
  cancellationReason: String,
  cancellationBreakdown: mongoose.Schema.Types.Mixed,

  rating: { stars: Number, review: String, ratedAt: Date },
  completedAt: Date,
}, { timestamps: true });

BookingSchema.index({ family: 1, status: 1 });
BookingSchema.index({ nanny: 1, status: 1 });
BookingSchema.index({ 'serviceDays.startAt': 1, status: 1 });

/** Days that have not yet been delivered (used for refunds and replacements). */
BookingSchema.methods.remainingDays = function () {
  return this.serviceDays.filter(
    (d) => d.status !== SERVICE_DAY_STATUS.COMPLETED && d.status !== SERVICE_DAY_STATUS.CANCELLED
  );
};

BookingSchema.methods.completedDays = function () {
  return this.serviceDays.filter((d) => d.status === SERVICE_DAY_STATUS.COMPLETED);
};

/** The day currently in play — the first not-yet-finished one. */
BookingSchema.methods.currentDay = function () {
  return this.serviceDays.find(
    (d) => d.status !== SERVICE_DAY_STATUS.COMPLETED && d.status !== SERVICE_DAY_STATUS.CANCELLED
  );
};

export default mongoose.model('Booking', BookingSchema);
