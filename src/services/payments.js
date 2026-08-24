import dayjs from 'dayjs';
import { Payment, Payout } from '../models/Payment.js';
import { nextSequence } from '../models/Counter.js';
import { Booking, User } from '../models/index.js';
import gateway from '../providers/payments.js';
import { PAYMENT_STATUS, PAYOUT_STATUS, BOOKING_STATUS, SERVICE_DAY_STATUS } from '../utils/constants.js';
import { round2 } from './policy.js';
import config from '../config/index.js';

async function reference(prefix) {
  return `${prefix}-${await nextSequence('payment_doc', 50000)}`;
}

/** Charge a family for a booking (or an additional top-up). */
export async function chargeBooking(booking, { method = 'credit_card', amount = null, kind = 'booking' } = {}) {
  const value = round2(amount ?? booking.totalAmount);
  const payment = await Payment.create({
    reference: await reference(kind === 'additional' ? 'ADD' : 'PAY'),
    booking: booking._id,
    family: booking.family,
    kind,
    method,
    amount: value,
    currency: config.currency,
    status: PAYMENT_STATUS.IN_PROCESS,
  });

  try {
    const result = await gateway.charge({
      amount: value,
      currency: config.currency,
      method,
      metadata: { bookingNumber: booking.bookingNumber },
    });

    if (!result.success) throw new Error(result.error || 'Payment declined');

    payment.status = PAYMENT_STATUS.COMPLETED;
    payment.providerRef = result.providerRef;
    payment.processedAt = result.processedAt;
    await payment.save();

    booking.paidAmount = round2((booking.paidAmount || 0) + value);
    booking.paymentStatus = PAYMENT_STATUS.COMPLETED;
    if (kind === 'additional') booking.additionalDue = 0;
    await booking.save();

    return { success: true, payment };
  } catch (err) {
    payment.status = PAYMENT_STATUS.FAILED;
    payment.failureReason = err.message;
    await payment.save();
    booking.paymentStatus = PAYMENT_STATUS.FAILED;
    await booking.save();
    return { success: false, payment, error: err.message };
  }
}

/** Issue a refund against a booking and record the breakdown. */
export async function refundBooking(booking, { amount, breakdown = null, reason = '' } = {}) {
  const value = round2(amount);
  if (value <= 0) return { success: true, payment: null, amount: 0 };

  const payment = await Payment.create({
    reference: await reference('RFD'),
    booking: booking._id,
    family: booking.family,
    kind: 'refund',
    method: 'system',
    amount: value,
    currency: config.currency,
    status: PAYMENT_STATUS.REFUND_IN_PROCESS,
    breakdown,
    failureReason: undefined,
  });

  const result = await gateway.refund({
    amount: value,
    currency: config.currency,
    metadata: { bookingNumber: booking.bookingNumber, reason },
  });

  payment.status = result.success ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.FAILED;
  payment.providerRef = result.providerRef;
  payment.processedAt = result.processedAt;
  await payment.save();

  if (result.success) {
    booking.paymentStatus = PAYMENT_STATUS.REFUNDED;
    await booking.save();
  }
  return { success: result.success, payment, amount: value };
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

/** Release every payout scheduled for today or earlier (the Monday job). */
export async function releaseDuePayouts(now = new Date()) {
  const due = await Payout.find({
    status: PAYOUT_STATUS.PENDING,
    scheduledFor: { $lte: now },
  });

  const released = [];
  for (const p of due) {
    p.status = PAYOUT_STATUS.PROCESSING;
    await p.save();
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await gateway.payout({
        amount: p.amount,
        currency: p.currency,
        metadata: { payoutRef: p.reference },
      });
      p.status = p.isFinalForBooking ? PAYOUT_STATUS.FINAL_DONE : PAYOUT_STATUS.COMPLETED;
      p.releasedAt = result.processedAt || new Date();
      await p.save();
      released.push(p);
    } catch (err) {
      p.status = PAYOUT_STATUS.FAILED;
      p.failureReason = err.message;
      await p.save();
    }
  }
  return released;
}

/** Earnings owed to a nanny for one completed service day (incl. overtime). */
export function dayEarnings(booking, day) {
  return round2((day.amount || 0) + (day.overtimeAmount || 0));
}

export default {
  chargeBooking, refundBooking, queuePayout, releaseDuePayouts,
  nextMonday, dayEarnings,
};
