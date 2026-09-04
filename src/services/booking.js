import dayjs from 'dayjs';
import { Booking, User, nextSequence } from '../models/index.js';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS,
  PAYMENT_STATUS, CANCELLED_BY, WEEKDAYS,
} from '../utils/constants.js';
import { computeBookingAmount, computeCancellationRefund, round2 } from './policy.js';
import { describeDay } from './calendar.js';
import config from '../config/index.js';

/** Random 4-char service code, e.g. "A123", as used in the script. */
export function generateServiceCode() {
  const letter = 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)];
  const digits = String(Math.floor(100 + Math.random() * 900));
  return `${letter}${digits}`;
}

/**
 * Expand a booking request into concrete dated service days.
 * Single-day  -> exactly one day.
 * Multi-day   -> every date between start and end that falls on a repeat day
 *                (all days, when no repeat days are given).
 *
 * Closed days — Nyepi above all — are left out rather than scheduled and
 * cancelled later, and days carrying a surcharge are priced individually, so
 * a booking that spans one is charged correctly instead of at a flat rate.
 * The calendar is passed in so this stays synchronous for its other callers.
 */
export function buildServiceDays({
  startDate, endDate, startTime, hoursPerDay, repeatDays = [], hourlyRate, calendar,
}) {
  const days = [];
  const [hh, mm] = String(startTime || '09:00').split(':').map(Number);
  const baseAmount = round2((hourlyRate || 0) * (hoursPerDay || 0));

  const from = dayjs(startDate);
  const to = endDate ? dayjs(endDate) : from;
  const useRepeat = repeatDays && repeatDays.length > 0;

  for (let d = from; d.isBefore(to, 'day') || d.isSame(to, 'day'); d = d.add(1, 'day')) {
    const weekday = WEEKDAYS[(d.day() + 6) % 7]; // dayjs: 0=Sunday -> our array starts Monday
    if (useRepeat && !repeatDays.includes(weekday)) continue;

    const date = d.format('YYYY-MM-DD');
    const special = calendar ? describeDay(date, calendar) : null;
    // Nobody works a closed day, so it is never scheduled or charged for.
    if (special?.closed) continue;

    const multiplier = special?.multiplier || 1;
    const startAt = d.hour(hh).minute(mm).second(0).millisecond(0);
    days.push({
      date,
      startAt: startAt.toDate(),
      endAt: startAt.add(hoursPerDay || 0, 'hour').toDate(),
      hours: hoursPerDay,
      amount: multiplier === 1 ? baseAmount : round2(baseAmount * multiplier),
      ...(multiplier === 1 ? {} : { rateMultiplier: multiplier, rateLabel: special.label }),
      status: SERVICE_DAY_STATUS.SCHEDULED,
      arrivalOtp: generateServiceCode(),
      endOtp: generateServiceCode(),
    });
  }
  return days;
}

/** Create a booking in DRAFT from the data a family assembled in the chat. */
export async function createBooking({ family, nanny, draft }) {
  // Price comes from the platform, not the nanny: every family pays the same
  // for the same number of children, and a family who has referred someone
  // pays the discounted rate. A nanny's own hourlyRate is what she is paid.
  const { hourlyRateFor } = await import('./pricing.js');
  const pricing = await hourlyRateFor({
    user: family,
    children: (draft.children || []).length || 1,
  });

  const hourlyRate = pricing.hourlyRate;

  // Surcharged and closed days are decided here, so the total below reflects
  // the days that will actually be worked.
  const { getCalendar } = await import('./calendar.js');
  const calendar = await getCalendar().catch(() => null);
  const serviceDays = buildServiceDays({ ...draft, hourlyRate, calendar });

  // Summed from the days rather than rate x hours x count, because a day
  // carrying a Nyepi-eve surcharge does not cost the same as a plain one.
  const totalAmount = round2(serviceDays.reduce((sum, d) => sum + (d.amount || 0), 0));

  const bookingNumber = String(await nextSequence('booking', 12344));

  const booking = await Booking.create({
    bookingNumber,
    family: family._id,
    nanny: nanny?._id,
    status: BOOKING_STATUS.PENDING_PAYMENT,
    isMultiDay: serviceDays.length > 1,
    startDate: draft.startDate,
    endDate: draft.endDate || draft.startDate,
    startTime: draft.startTime,
    hoursPerDay: draft.hoursPerDay,
    repeatDays: draft.repeatDays || [],
    serviceDays,
    address: draft.address || {},
    requirements: {
      languages: draft.languages || [],
      skills: draft.skills || [],
      subjects: draft.subjects || [],
      budgetMin: draft.budgetMin,
      budgetMax: draft.budgetMax,
      cpr: draft.cpr,
    },
    children: draft.children || [],
    isEmergency: !!draft.isEmergency,
    otherInstructions: draft.otherInstructions,
    agentCallRequested: !!draft.agentCallRequested,
    hourlyRate,
    totalAmount,
    // Kept so support can explain a price months later without recomputing it.
    standardHourlyRate: pricing.standardRate,
    referralDiscountApplied: pricing.discounted,
    paymentStatus: PAYMENT_STATUS.IN_PROCESS,
  });
  return booking;
}

/**
 * Recalculate totals after an edit (duration, dates, repeat days or rate).
 * Preserves the status and confirmation codes of days that already happened.
 */
export function recalcServiceDays(booking, changes = {}) {
  const merged = {
    startDate: changes.startDate ?? booking.startDate,
    endDate: changes.endDate ?? booking.endDate,
    startTime: changes.startTime ?? booking.startTime,
    hoursPerDay: changes.hoursPerDay ?? booking.hoursPerDay,
    repeatDays: changes.repeatDays ?? booking.repeatDays,
    hourlyRate: changes.hourlyRate ?? booking.hourlyRate,
  };

  const completed = booking.serviceDays.filter(
    (d) => d.status === SERVICE_DAY_STATUS.COMPLETED || d.status === SERVICE_DAY_STATUS.CANCELLED
  );
  const fresh = buildServiceDays(merged).filter(
    (nd) => !completed.some((cd) => cd.date === nd.date)
  );

  const days = [...completed.map((d) => d.toObject?.() ?? d), ...fresh]
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  const total = round2(days.reduce((s, d) => s + (d.amount || 0), 0));
  return { serviceDays: days, totalAmount: total, merged };
}

/**
 * Register that a booking request was sent to a nanny and start her response
 * clock: 1 hour for a new booking, 2 hours for a change to an existing one.
 * The countdown starts when the nanny is notified, per the spec.
 */
export function openNannyResponseWindow(booking, nannyId, kind = 'new_booking') {
  const minutes = kind === 'booking_change'
    ? config.changeBookingResponseMinutes
    : config.newBookingResponseMinutes;
  const sentAt = new Date();
  const expiresAt = new Date(sentAt.getTime() + minutes * 60000);

  booking.nannyResponses.push({
    nanny: nannyId, kind, sentAt, expiresAt, outcome: 'pending',
  });
  booking.subStatus = kind === 'booking_change'
    ? BOOKING_SUBSTATUS.AWAITING_CHANGE_CONFIRMATION
    : BOOKING_SUBSTATUS.AWAITING_NANNY_CONFIRMATION;
  return { sentAt, expiresAt, minutes };
}

export function pendingResponse(booking) {
  return booking.nannyResponses.find((r) => r.outcome === 'pending');
}

/** True while the original nanny still owns the decision (no alternatives shown). */
export function isInResponseWindow(booking) {
  const p = pendingResponse(booking);
  return !!p && new Date(p.expiresAt) > new Date();
}

/** Mark a booking ONGOING/COMPLETED based on where its service days stand. */
export function syncBookingStatus(booking) {
  const days = booking.serviceDays || [];
  const active = days.filter((d) => d.status !== SERVICE_DAY_STATUS.CANCELLED);
  if (!active.length) {
    booking.status = BOOKING_STATUS.CANCELLED;
    booking.subStatus = undefined;
    return booking;
  }

  const allDone = active.every((d) => d.status === SERVICE_DAY_STATUS.COMPLETED);
  if (allDone) {
    booking.status = BOOKING_STATUS.COMPLETED;
    booking.subStatus = undefined;
    booking.completedAt = booking.completedAt || new Date();
    return booking;
  }

  const current = active.find((d) => d.status !== SERVICE_DAY_STATUS.COMPLETED);
  const inFlight = [
    SERVICE_DAY_STATUS.AWAITING_ARRIVAL,
    SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED,
    SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE,
  ].includes(current.status);

  const anyCompleted = active.some((d) => d.status === SERVICE_DAY_STATUS.COMPLETED);

  if (inFlight || anyCompleted) {
    booking.status = BOOKING_STATUS.ONGOING;
    const map = {
      [SERVICE_DAY_STATUS.AWAITING_ARRIVAL]: BOOKING_SUBSTATUS.AWAITING_ARRIVAL,
      [SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED]: BOOKING_SUBSTATUS.ARRIVAL_CONFIRMED,
      [SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE]: BOOKING_SUBSTATUS.AWAITING_END_OF_SERVICE,
    };
    // Between days the booking is ongoing but today's work is done.
    booking.subStatus = map[current.status] || BOOKING_SUBSTATUS.TODAYS_SERVICE_COMPLETED;
  }
  return booking;
}

/** Apply a cancellation and record the refund/compensation breakdown. */
export async function cancelBooking(booking, { cancelledBy, reason, at = new Date(), dayIds = null }) {
  const breakdown = computeCancellationRefund(booking, { cancelledBy, at, dayIds });

  for (const day of booking.serviceDays) {
    if (day.status === SERVICE_DAY_STATUS.COMPLETED) continue;
    if (dayIds && !dayIds.map(String).includes(String(day._id))) continue;
    const row = breakdown.perDay.find((p) => String(p.dayId) === String(day._id));
    day.status = SERVICE_DAY_STATUS.CANCELLED;
    day.cancelledAt = at;
    day.refundAmount = row?.familyRefund ?? 0;
    day.nannyCompensation = row?.nannyCompensation ?? 0;
  }

  booking.cancelledBy = cancelledBy;
  booking.cancelledAt = at;
  booking.cancellationReason = reason;
  booking.cancellationBreakdown = breakdown;
  // What the policy says we owe. `refundedAmount` is only credited once an
  // admin has actually transferred the money, so the dashboard never shows
  // a refund as paid while it is still sitting in our account.
  booking.refundDue = round2((booking.refundDue || 0) + breakdown.totalRefund);
  booking.paymentStatus = breakdown.totalRefund > 0
    ? PAYMENT_STATUS.REFUND_IN_PROCESS
    : booking.paymentStatus;

  syncBookingStatus(booking);
  if (booking.status !== BOOKING_STATUS.COMPLETED) {
    booking.status = BOOKING_STATUS.CANCELLED;
    booking.subStatus = undefined;
  }
  await booking.save();
  return breakdown;
}

/**
 * Nanny walks away from a booking she had accepted. Per the spec the booking is
 * NOT cancelled — it enters a replacement-needed state so the family can pick
 * someone else without rebuilding the booking.
 */
export async function markNannyCancelled(booking, { at = new Date(), reason } = {}) {
  booking.replacementOfNanny = booking.nanny;
  if (booking.nanny && !booking.rejectedNannies.some((id) => String(id) === String(booking.nanny))) {
    booking.rejectedNannies.push(booking.nanny);
  }
  booking.nanny = undefined;
  booking.subStatus = BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT;
  booking.cancellationReason = reason;

  // Ongoing stays ongoing; an upcoming booking stays upcoming.
  const anyCompleted = booking.serviceDays.some((d) => d.status === SERVICE_DAY_STATUS.COMPLETED);
  booking.status = anyCompleted ? BOOKING_STATUS.ONGOING : BOOKING_STATUS.UPCOMING;

  // Reset in-flight days back to scheduled so a replacement can pick them up.
  for (const day of booking.serviceDays) {
    if ([SERVICE_DAY_STATUS.AWAITING_ARRIVAL, SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED,
      SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE].includes(day.status)) {
      day.status = SERVICE_DAY_STATUS.SCHEDULED;
    }
  }
  booking.markModified('serviceDays');
  await booking.save();
  return booking;
}

/**
 * Attach a replacement nanny. If she costs more, the difference must be paid
 * before the booking becomes active again.
 */
export async function assignReplacement(booking, nanny) {
  const remaining = booking.remainingDays();
  const remainingHours = remaining.reduce((s, d) => s + (d.hours || 0), 0);
  const oldRate = booking.hourlyRate || 0;
  const newRate = nanny.hourlyRate || 0;
  const difference = round2((newRate - oldRate) * remainingHours);

  booking.nanny = nanny._id;
  for (const d of remaining) {
    d.nanny = nanny._id;
    if (newRate !== oldRate) d.amount = round2(newRate * (d.hours || 0));
  }
  booking.markModified('serviceDays');

  if (difference > 0) {
    booking.additionalDue = difference;
    booking.status = BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT;
    booking.subStatus = undefined;
  } else {
    booking.additionalDue = 0;
    booking.hourlyRate = newRate;
    booking.totalAmount = round2(
      booking.completedDays().reduce((s, d) => s + (d.amount || 0), 0) +
      remaining.reduce((s, d) => s + (d.amount || 0), 0)
    );
  }
  await booking.save();
  return { difference, requiresPayment: difference > 0 };
}

export default {
  generateServiceCode, buildServiceDays, createBooking, recalcServiceDays,
  openNannyResponseWindow, pendingResponse, isInResponseWindow,
  syncBookingStatus, cancelBooking, markNannyCancelled, assignReplacement,
};
