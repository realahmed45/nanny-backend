import dayjs from 'dayjs';
import { Payment, Payout } from '../models/Payment.js';
import { nextSequence } from '../models/Counter.js';
import { Booking, User } from '../models/index.js';
import { PAYMENT_STATUS, PAYOUT_STATUS, BOOKING_STATUS, SERVICE_DAY_STATUS } from '../utils/constants.js';
import { round2 } from './policy.js';
import config from '../config/index.js';

/**
 * Money is moved by manual bank transfer, outside this system.
 *
 * The family transfers the amount and uploads a screenshot of the receipt; an
 * admin checks it against the bank and approves or rejects it. Nothing here
 * talks to a payment gateway — these functions only keep the record straight,
 * so what the dashboard shows always matches what a human actually verified.
 *
 * The lifecycle of a payment is therefore:
 *   IN_PROCESS  — proof uploaded, waiting for an admin
 *   COMPLETED   — admin confirmed the transfer landed
 *   FAILED      — admin rejected it (wrong amount, unreadable, not received)
 *
 * and for refunds:
 *   REFUND_IN_PROCESS — owed to the family, admin still has to send it
 *   REFUNDED          — admin sent it and recorded the proof
 */

async function reference(prefix) {
  return `${prefix}-${await nextSequence('payment_doc', 50000)}`;
}

/**
 * Record a family's transfer for a booking (or an additional top-up) and put it
 * in the admin review queue. `proof` is the screenshot the family uploaded.
 */
export async function recordTransfer(booking, { amount = null, kind = 'booking', proof = {} } = {}) {
  const value = round2(amount ?? booking.totalAmount);

  const payment = await Payment.create({
    reference: await reference(kind === 'additional' ? 'ADD' : 'PAY'),
    booking: booking._id,
    family: booking.family,
    kind,
    method: 'bank_transfer',
    amount: value,
    currency: config.currency,
    status: PAYMENT_STATUS.IN_PROCESS,
    proof: {
      url: proof.url,
      mediaId: proof.mediaId,
      uploadedAt: new Date(),
      note: proof.note,
    },
  });

  booking.paymentStatus = PAYMENT_STATUS.IN_PROCESS;
  await booking.save();

  return { success: true, payment };
}

/**
 * An admin confirmed the transfer arrived. This is the only path that marks a
 * booking paid, so the money in the dashboard always reflects a human check.
 */
export async function approveTransfer(payment, { adminId = null, note = '' } = {}) {
  if (payment.status === PAYMENT_STATUS.COMPLETED) {
    return { success: true, payment, alreadyApproved: true };
  }

  payment.status = PAYMENT_STATUS.COMPLETED;
  payment.reviewedBy = adminId;
  payment.reviewedAt = new Date();
  payment.reviewNote = note;
  payment.processedAt = new Date();
  await payment.save();

  const booking = await Booking.findById(payment.booking);
  if (booking) {
    booking.paidAmount = round2((booking.paidAmount || 0) + (payment.amount || 0));
    booking.paymentStatus = PAYMENT_STATUS.COMPLETED;
    if (payment.kind === 'additional') {
      booking.totalAmount = round2((booking.totalAmount || 0) + (payment.amount || 0));
      booking.additionalDue = 0;
    }
    await booking.save();
  }

  // Wire 4 of the referral engine — OR10.
  //
  // Here rather than at booking creation, because a booking is created unpaid
  // and verified by a person later. Freezing on creation would settle
  // attribution on bookings that were never paid, and could be used to lock a
  // rival's referral out of a claim it had legitimately won.
  //
  // Safe to run more than once: this function returns early on an already
  // approved payment, and the conversion is keyed on the booking anyway.
  if (booking) {
    try {
      const { User } = await import('../models/index.js');
      const family = await User.findById(booking.family);
      if (family) {
        const { resolveOnBooking } = await import('./referralAttribution.js');
        const result = await resolveOnBooking(family, booking);

        // OR3's cost, surfaced before anyone has to ask: a referrer swapped
        // just before this booking means someone lost a claim they earned,
        // and split credit is not an option here.
        if (result.changed) {
          const { checkCreditSniping } = await import('./linkAbuseDetector.js');
          await checkCreditSniping(family, booking).catch(() => {});
        }
      }
    } catch (err) {
      // Attribution must never block a verified payment.
      console.error('[referral] could not settle attribution:', err.message);
    }
  }

  return { success: true, payment, booking };
}

/** An admin rejected the proof — the family has to transfer again. */
export async function rejectTransfer(payment, { adminId = null, note = '' } = {}) {
  payment.status = PAYMENT_STATUS.FAILED;
  payment.reviewedBy = adminId;
  payment.reviewedAt = new Date();
  payment.reviewNote = note;
  payment.failureReason = note || 'Transfer could not be verified';
  await payment.save();

  const booking = await Booking.findById(payment.booking);
  if (booking) {
    booking.paymentStatus = PAYMENT_STATUS.FAILED;
    await booking.save();
  }

  return { success: true, payment, booking };
}

/**
 * Record that a refund is owed. No money moves here — an admin transfers it
 * manually and then calls `completeRefund` with the proof.
 */
export async function refundBooking(booking, { amount, breakdown = null, reason = '' } = {}) {
  const value = round2(amount);
  if (value <= 0) return { success: true, payment: null, amount: 0 };

  const payment = await Payment.create({
    reference: await reference('RFD'),
    booking: booking._id,
    family: booking.family,
    kind: 'refund',
    method: 'bank_transfer',
    amount: value,
    currency: config.currency,
    status: PAYMENT_STATUS.REFUND_IN_PROCESS,
    breakdown,
    reviewNote: reason,
  });

  booking.paymentStatus = PAYMENT_STATUS.REFUND_IN_PROCESS;
  await booking.save();

  return { success: true, payment, amount: value };
}

/** An admin sent the refund by transfer and attached the receipt. */
export async function completeRefund(payment, { adminId = null, proof = {}, note = '' } = {}) {
  payment.status = PAYMENT_STATUS.REFUNDED;
  payment.reviewedBy = adminId;
  payment.reviewedAt = new Date();
  payment.processedAt = new Date();
  if (note) payment.reviewNote = note;
  payment.refundProof = {
    url: proof.url,
    mediaId: proof.mediaId,
    uploadedAt: proof.url ? new Date() : undefined,
  };
  await payment.save();

  const booking = await Booking.findById(payment.booking);
  if (booking) {
    booking.refundedAmount = round2((booking.refundedAmount || 0) + (payment.amount || 0));
    booking.paymentStatus = PAYMENT_STATUS.REFUNDED;
    await booking.save();
  }

  return { success: true, payment, booking };
}

/** The Monday on or after a date — payouts are released weekly on Monday. */
export function nextMonday(from = new Date()) {
  let d = dayjs(from).startOf('day');
  while (d.day() !== 1) d = d.add(1, 'day');
  return d.toDate();
}

/**
 * Queue a nanny payout for completed service day(s).
 * Called when a service day completes, or when a cancellation leaves the nanny
 * with compensation.
 */
export async function queuePayout(booking, { nannyId, amount, serviceDayIds = [], isFinal = false, notes = '' }) {
  const value = round2(amount);
  if (value <= 0) return null;

  return Payout.create({
    reference: await reference('PYT'),
    nanny: nannyId || booking.nanny,
    booking: booking._id,
    serviceDayIds: serviceDayIds.map(String),
    amount: value,
    currency: config.currency,
    status: PAYOUT_STATUS.PENDING,
    scheduledFor: nextMonday(),
    isFinalForBooking: isFinal,
    notes,
  });
}

/**
 * The Monday job moves due payouts into "processing" — an admin then transfers
 * each one by hand and marks it released. Nothing is auto-completed, because no
 * money can move without a person doing it.
 */
export async function releaseDuePayouts(now = new Date()) {
  const due = await Payout.find({
    status: PAYOUT_STATUS.PENDING,
    scheduledFor: { $lte: now },
  });

  const queued = [];
  for (const p of due) {
    p.status = PAYOUT_STATUS.PROCESSING;
    // eslint-disable-next-line no-await-in-loop
    await p.save();
    queued.push(p);
  }
  return queued;
}

/** An admin transferred a payout to the nanny and recorded the proof. */
export async function markPayoutPaid(payout, { adminId = null, proof = {}, note = '' } = {}) {
  payout.status = payout.isFinalForBooking ? PAYOUT_STATUS.FINAL_DONE : PAYOUT_STATUS.COMPLETED;
  payout.releasedAt = new Date();
  payout.releasedBy = adminId;
  if (note) payout.notes = note;
  payout.proof = {
    url: proof.url,
    mediaId: proof.mediaId,
    uploadedAt: proof.url ? new Date() : undefined,
  };
  await payout.save();
  return { success: true, payout };
}

/** Earnings owed to a nanny for one completed service day (incl. overtime). */
export function dayEarnings(booking, day) {
  return round2((day.amount || 0) + (day.overtimeAmount || 0));
}

export default {
  recordTransfer, approveTransfer, rejectTransfer,
  refundBooking, completeRefund,
  queuePayout, releaseDuePayouts, markPayoutPaid,
  nextMonday, dayEarnings,
};
