import crypto from 'node:crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { Booking, User, nextSequence } from '../models/index.js';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS,
  PAYMENT_STATUS, CANCELLED_BY, WEEKDAYS,
} from '../utils/constants.js';
import { computeBookingAmount, computeCancellationRefund, round2 } from './policy.js';
import { dayWorkers } from './payments.js';
import { describeDay } from './calendar.js';
import config from '../config/index.js';
import { emergencySurcharge } from './settings.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * A 6-digit service code, from a cryptographic source.
 *
 * The old code was a letter and three digits from Math.random — about 21,600
 * possibilities, guessable by a script with no limit on tries — so a nanny
 * could confirm arrival or check-out without being there. Six digits gives a
 * million, and entry now locks after five wrong tries (see nannyMenu.js).
 * Codes already issued in the old format are still accepted.
 */
export function generateServiceCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
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
    /**
     * 09:00 means nine in the morning where the nanny is standing.
     *
     * Built from the calendar date and the wall-clock time in the business
     * timezone, not the host's. `d.hour(hh)` read the server's zone, so on a UTC
     * host a 09:00 Bali booking was stored as 09:00Z — eight hours out, which
     * the phone then displayed as 5:00 PM.
     */
    const startAt = dayjs.tz(`${date} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, config.timezone);
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

  // The other nanny on a 24h booking, loaded only for her salary rate — she
  // may be on a different one, and both have to be locked in at booking time.
  const secondNannyDoc = draft.secondNanny
    ? await User.findById(draft.secondNanny).select('hourlyRate')
    : null;

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
    // Locked in at booking time so a later rate change cannot rewrite it.
    emergencySurcharge: draft.isEmergency ? await emergencySurcharge() : 0,
    endDateUnknown: !!draft.endDateUnknown,
    isLiveIn: !!draft.isLiveIn,
    needsAgentReview: !!draft.needsAgentReview,
    nanniesNeeded: draft.nanniesNeeded || 1,
    secondNanny: draft.secondNanny || undefined,
    otherInstructions: draft.otherInstructions,
    agentCallRequested: !!draft.agentCallRequested,
    hourlyRate,
    totalAmount,
    // Her own agreed salary rate, copied from her profile as it stands today.
    // Separate from `hourlyRate` above, which is what the family pays: the gap
    // between the two is our commission. Locked here so a later renegotiation
    // cannot change what she is owed for work already done.
    nannyHourlyRate: nanny?.hourlyRate || 0,
    secondNannyHourlyRate: secondNannyDoc?.hourlyRate || undefined,
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
export async function recalcServiceDays(booking, changes = {}) {
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
  // The calendar is what makes a Nyepi date get skipped and a surcharged day
  // cost more. Rebuilding without it silently repriced every day at the flat
  // rate — dropping the surcharge the family owed — and put working days back
  // on dates the island is closed, sending a nanny to a booking that cannot
  // happen.
  const { getCalendar } = await import('./calendar.js');
  const calendar = await getCalendar().catch(() => null);

  const fresh = buildServiceDays({ ...merged, calendar }).filter(
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

/**
 * The request currently waiting on a nanny.
 *
 * The newest one, and one belonging to a nanny still on the booking. Taking
 * the first pending entry found an old request from a nanny who had since left
 * before the replacement's own.
 */
/**
 * Take one nanny off a booking: whichever seat she is in.
 *
 * Every path that removed a nanny wrote `booking.nanny = undefined`, whoever
 * was leaving. On a 24h booking, when the second nanny declined, timed out or
 * cancelled, the first nanny — who had accepted and was working — was the one
 * removed, and the nanny who left stayed on and kept being paid.
 *
 * Returns which seat was emptied ('first', 'second' or null).
 */
/**
 * Can this nanny accept this request right now? Null when she can, otherwise
 * the reason she cannot ('closed' or 'busy').
 *
 * One check for every way of accepting — WhatsApp and the phone app, a new
 * booking and a change of dates. Only the app path checked availability, and
 * only for new bookings: on WhatsApp, the main channel, two families who both
 * paid could be confirmed for the same nanny on the same morning, and a date
 * change could be accepted over another booking she already had. A request on
 * a booking cancelled in the meantime is closed, not accepted — accepting it
 * used to bring the cancelled booking back to life.
 */
export async function acceptBlocker(booking, nanny, pending) {
  if ([BOOKING_STATUS.CANCELLED, BOOKING_STATUS.COMPLETED].includes(booking.status)) return 'closed';

  let serviceDays = booking.remainingDays();
  let { hoursPerDay } = booking;
  const change = booking.pendingChange;
  if (pending?.kind === 'booking_change' && change?.kind === 'reschedule') {
    const next = await recalcServiceDays(booking, change);
    serviceDays = next.serviceDays.filter((d) => d.status === SERVICE_DAY_STATUS.SCHEDULED);
    hoursPerDay = next.merged.hoursPerDay;
  }

  const { isNannyAvailable } = await import('./matching.js');
  const free = await isNannyAvailable(nanny, {
    serviceDays, hoursPerDay, excludeBookingId: booking._id,
  });
  return free ? null : 'busy';
}

/**
 * Is another nanny on the booking still to answer the same change?
 * A change is applied only when the last of them accepts.
 */
export function changeStillAwaited(booking, pending) {
  return (booking.nannyResponses || []).some((r) => r !== pending
    && r.outcome === 'pending'
    && r.kind === 'booking_change'
    && String(r.nanny) !== String(pending?.nanny));
}

export function removeNannyFromBooking(booking, nannyId) {
  const id = String(nannyId?._id || nannyId || '');
  if (!id) return null;
  if (booking.secondNanny && String(booking.secondNanny?._id || booking.secondNanny) === id) {
    booking.secondNanny = undefined;
    return 'second';
  }
  if (booking.nanny && String(booking.nanny?._id || booking.nanny) === id) {
    booking.nanny = undefined;
    return 'first';
  }
  return null;
}

export function pendingResponse(booking) {
  const onBooking = new Set(
    [booking.nanny, booking.secondNanny].filter(Boolean).map((id) => String(id?._id || id)),
  );
  const open = (booking.nannyResponses || []).filter((r) => r.outcome === 'pending');
  return [...open].reverse().find((r) => onBooking.has(String(r.nanny)))
    || open[open.length - 1];
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
    // A booking waiting on a top-up keeps that status while the balance is
    // outstanding. The days still run — the scheduler deliberately includes
    // this status — but flipping it to ONGOING here would erase the only
    // signal that money is still owed, and the dashboard would stop chasing
    // it. `additionalDue` returning to zero is what releases it.
    const awaitingTopUp = booking.status === BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT
      && (booking.additionalDue || 0) > 0;

    if (!awaitingTopUp) booking.status = BOOKING_STATUS.ONGOING;
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

/**
 * What a cancellation refunds and compensates — the one quote used by the
 * preview, the cancellation itself, and the payouts that follow.
 *
 * Three rules the raw policy table does not know about:
 *
 *  - The nanny caused it. When a family cancels because their nanny quit (or
 *    while an unconfirmed replacement is still deciding), they were promised a
 *    full refund. Running the family-cancels notice bands instead could refund
 *    them nothing and pay "compensation" to a nanny who had left. So it is
 *    priced as a nanny cancellation: every unworked day refunded, nothing paid
 *    to anyone for days she will not work.
 *
 *  - Compensation is at the nanny's own rate. The policy works in the family's
 *    price, which paid a nanny more for a cancelled day than for working it.
 *    The policy's percentage is kept and applied to what she would have earned,
 *    split between both nannies on a 24-hour booking.
 *
 *  - Nothing beyond what was paid. A refund can never exceed what the family
 *    actually paid less what is already being refunded, and an unpaid booking
 *    refunds nothing and compensates nobody.
 */
export function cancellationQuote(booking, { cancelledBy, at = new Date(), dayIds = null } = {}) {
  const nannyCaused = cancelledBy === CANCELLED_BY.FAMILY && (
    booking.subStatus === BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT
    || (booking.replacementOfNanny
      && booking.subStatus === BOOKING_SUBSTATUS.AWAITING_NANNY_CONFIRMATION)
    || !booking.nanny
  );
  const breakdown = computeCancellationRefund(booking, {
    cancelledBy: nannyCaused ? CANCELLED_BY.NANNY : cancelledBy, at, dayIds,
  });

  const paid = Number(booking.paidAmount || 0);
  let totalComp = 0;
  for (const row of breakdown.perDay || []) {
    row.compensationSplit = [];
    if (!(row.nannyCompensation > 0) || !(row.amount > 0) || paid <= 0) {
      row.nannyCompensation = 0;
      continue;
    }
    const day = (booking.serviceDays || []).find((d) => String(d._id) === String(row.dayId));
    const pct = row.nannyCompensation / row.amount;
    const workers = day ? dayWorkers(booking, day).filter((w) => w.nannyId) : [];
    row.compensationSplit = workers.map((w) => ({ nannyId: w.nannyId, amount: round2(w.base * pct) }));
    row.nannyCompensation = round2(row.compensationSplit.reduce((s, x) => s + x.amount, 0));
    totalComp += row.nannyCompensation;
  }
  breakdown.totalNannyCompensation = round2(totalComp);

  const refundable = Math.max(0, round2(paid - (booking.refundDue || 0)));
  if (breakdown.totalRefund > refundable) {
    breakdown.totalRefund = refundable;
    breakdown.cappedToPaid = true;
  }
  breakdown.nannyCaused = nannyCaused;
  return breakdown;
}

/**
 * Queue the compensation in a cancellation quote: one payout per nanny, for
 * her own share. Paying it all to `booking.nanny` lost it entirely once she
 * had been cleared off, and on a 24-hour booking gave the second nanny none.
 */
export async function payCancellationCompensation(booking, breakdown, notes = 'Cancellation compensation') {
  const owed = new Map();
  for (const row of breakdown.perDay || []) {
    for (const part of row.compensationSplit || []) {
      owed.set(part.nannyId, round2((owed.get(part.nannyId) || 0) + part.amount));
    }
  }
  const { queuePayout } = await import('./payments.js');
  for (const [nannyId, amount] of owed) {
    // eslint-disable-next-line no-await-in-loop
    if (amount > 0) await queuePayout(booking, { nannyId, amount, isFinal: true, notes });
  }
  return owed;
}

/** Apply a cancellation and record the refund/compensation breakdown. */
export async function cancelBooking(booking, { cancelledBy, reason, at = new Date(), dayIds = null }) {
  // Cancelling an already-cancelled booking must not refund a second time.
  //
  // Two paths can reach the same booking at once: the family confirming a
  // cancellation they had open, and the replacement sweep cancelling it for
  // them. Both computed a full refund against days the other had not yet
  // written, and `refundDue` accumulates — so two refund rows were raised for
  // one booking, and an admin approving both paid the family twice.
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    return booking.cancellationBreakdown
      || { perDay: [], totalRefund: 0, totalNannyCompensation: 0 };
  }

  const breakdown = cancellationQuote(booking, { cancelledBy, at, dayIds });

  /**
   * What each cancelled day refunds, and what we keep of its price.
   *
   * The refund per day is scaled down when the total was capped at what the
   * family actually paid. What is kept is recorded on the day so revenue can
   * count it: the profit figures used to count only worked days as revenue
   * and then subtract the refunds for unworked ones, losing that money twice.
   * Kept money can never exceed what was paid and not refunded.
   */
  const rows = breakdown.perDay || [];
  const policyRefund = rows.reduce((s, r) => s + (r.familyRefund || 0), 0);
  const scale = policyRefund > 0 ? Math.min(1, breakdown.totalRefund / policyRefund) : 1;
  const cancelling = booking.serviceDays.filter((d) => d.status !== SERVICE_DAY_STATUS.COMPLETED
    && (!dayIds || dayIds.map(String).includes(String(d._id))));
  const keepRaw = cancelling.map((d) => {
    const row = rows.find((p) => String(p.dayId) === String(d._id));
    return Math.max(0, (row?.amount ?? d.amount ?? 0) - round2((row?.familyRefund ?? 0) * scale));
  });
  const completedCharged = booking.serviceDays
    .filter((d) => d.status === SERVICE_DAY_STATUS.COMPLETED)
    .reduce((s, d) => s + (d.amount || 0), 0);
  const keepable = Math.max(0, (booking.paidAmount || 0) - (booking.refundDue || 0)
    - breakdown.totalRefund - completedCharged);
  const keepTotal = keepRaw.reduce((s, x) => s + x, 0);
  const keepScale = keepTotal > keepable ? (keepTotal > 0 ? keepable / keepTotal : 0) : 1;

  cancelling.forEach((day, i) => {
    const row = rows.find((p) => String(p.dayId) === String(day._id));
    day.status = SERVICE_DAY_STATUS.CANCELLED;
    day.cancelledAt = at;
    day.refundAmount = round2((row?.familyRefund ?? 0) * scale);
    day.nannyCompensation = row?.nannyCompensation ?? 0;
    day.cancellationKept = round2(keepRaw[i] * keepScale);
  });

  // Any request still waiting on a nanny is over. Left open, she could press
  // "accept" after the cancellation and bring the booking back to life — the
  // family, already being refunded, was told "Booking Confirmed".
  for (const r of booking.nannyResponses || []) {
    if (r.outcome !== 'pending') continue;
    r.outcome = 'declined';
    r.respondedAt = at;
    r.declineReason = 'Booking cancelled';
  }
  booking.pendingChange = undefined;

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
export async function markNannyCancelled(booking, { at = new Date(), reason, nannyId = null } = {}) {
  // The nanny who is leaving — on a 24h booking that may be the second one.
  const leaving = String(nannyId || booking.nanny || '');
  booking.replacementOfNanny = leaving || booking.nanny;
  if (leaving && !booking.rejectedNannies.some((id) => String(id) === leaving)) {
    booking.rejectedNannies.push(leaving);
  }
  const seat = removeNannyFromBooking(booking, leaving) || (booking.nanny = undefined, 'first');
  booking.subStatus = BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT;
  booking.cancellationReason = reason;

  // Ongoing stays ongoing; an upcoming booking stays upcoming — and one still
  // waiting on a top-up keeps saying so, or the balance stops being chased.
  booking.status = restingStatus(booking);

  // Her own open request (a change she had not answered yet) closes with her.
  // Left pending, it was found before the replacement's own request by every
  // lookup that takes the first pending one: the family could be shown her
  // countdown, and the timeout sweep acted on her entry instead.
  for (const r of booking.nannyResponses || []) {
    if (r.outcome === 'pending' && String(r.nanny) === String(booking.replacementOfNanny)) {
      r.outcome = 'declined';
      r.respondedAt = at;
      r.declineReason = 'Nanny cancelled the booking';
      // A change she was asked to approve dies with her request; the booking
      // stays as it was rather than holding a change nobody will answer.
      if (r.kind === 'booking_change') booking.pendingChange = undefined;
    }
  }

  // Reset in-flight days back to scheduled so a replacement can pick them up —
  // only when the first nanny left. On a 24h booking the second nanny leaving
  // does not stop the first one's day that is already under way.
  for (const day of booking.serviceDays) {
    if (seat !== 'first') break;
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
  // The price is the platform's, set from the pricing table at booking time,
  // and it does not depend on who takes the job — which is exactly what the
  // family is told on the screen before this runs.
  //
  // This used to re-price the remaining days off `nanny.hourlyRate`. That is
  // her *payout* rate, not the rate charged, and the two are deliberately
  // different: the platform marks up. So a replacement whose payout was lower
  // than the charge — the ordinary case — refunded the family a large sum they
  // were never owed and rewrote the booking total downward, while a payout
  // above the charge billed them for a difference that did not exist.
  /**
   * The days she takes over: the ones not yet begun.
   *
   * A day already in progress stays with the nanny working it. Re-stamping it
   * moved that day's pay to the new nanny, who had not worked it.
   */
  const IN_PROGRESS = [
    SERVICE_DAY_STATUS.AWAITING_ARRIVAL,
    SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED,
    SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE,
  ];
  const remaining = booking.remainingDays().filter((d) => !IN_PROGRESS.includes(d.status));

  /**
   * Is she still free? Asked here, not only when she was searched for.
   *
   * Availability used to be checked in one place — inside the search — and
   * every path that actually committed a nanny skipped it. Between a family
   * seeing her and this running sits a bank transfer, a receipt photo and a
   * manual approval: hours or days. Two families could both be shown her, both
   * pay, and both be confirmed, and one of them would arrive to no nanny.
   */
  const { isNannyAvailable } = await import('./matching.js');
  const free = await isNannyAvailable(nanny, {
    serviceDays: remaining,
    hoursPerDay: booking.hoursPerDay,
    excludeBookingId: booking._id,
  });
  if (!free) {
    const err = new Error('That nanny is no longer available for these dates.');
    err.code = 'NANNY_UNAVAILABLE';
    throw err;
  }

  /**
   * Which seat she fills.
   *
   * On a two-nanny booking whose second nanny left, the empty seat is the
   * second one. This always wrote `booking.nanny`, so the family's pick pushed
   * out the first nanny — who was still working — and the second seat stayed
   * empty.
   */
  const secondSeat = (booking.nanniesNeeded || 1) > 1 && booking.nanny && !booking.secondNanny;
  const previous = secondSeat ? null : booking.nanny;

  /**
   * Who worked each day, and at what rate, written down before anything moves.
   *
   * Days already worked keep the nanny who worked them and her rate. Without
   * the stamp they were credited to whoever held the booking last, and paid
   * at the booking's single rate — so a replacement was paid her predecessor's
   * salary, over- or underpaying her by the difference.
   */
  const leaving = booking.nanny || booking.replacementOfNanny;
  for (const d of booking.serviceDays || []) {
    if (remaining.includes(d)) continue;
    if (!d.nanny && leaving && !secondSeat) d.nanny = leaving;
    if (!d.nannyRate && !secondSeat) d.nannyRate = booking.nannyHourlyRate || 0;
  }

  if (secondSeat) {
    booking.secondNanny = nanny._id;
    booking.secondNannyHourlyRate = nanny.hourlyRate || booking.secondNannyHourlyRate;
  } else {
    booking.nanny = nanny._id;
    for (const d of remaining) {
      d.nanny = nanny._id;
      d.nannyRate = nanny.hourlyRate || booking.nannyHourlyRate || 0;
    }
    // Her own agreed rate from here on, for anything that reads the booking's.
    if (nanny.hourlyRate) booking.nannyHourlyRate = nanny.hourlyRate;
  }
  booking.markModified('serviceDays');

  // The nanny being replaced is told, so she does not turn up to a job that
  // is no longer hers. One who cancelled herself is already off the booking.
  if (previous && String(previous) !== String(nanny._id)) {
    const { notifyUser } = await import('./notify.js');
    const gone = await User.findById(previous);
    if (gone) {
      await notifyUser(gone, `Booking #${booking.bookingNumber} has been given to another nanny, so you are no longer booked for it. Please do not go to the family. Thank you.`).catch(() => {});
    }
  }

  // A request still open for the nanny being replaced is over: she is no
  // longer on the booking. Left pending it would be found ahead of the new
  // nanny's own request.
  for (const r of booking.nannyResponses || []) {
    if (r.outcome === 'pending' && previous && String(r.nanny) === String(previous)) {
      r.outcome = 'declined';
      r.respondedAt = new Date();
      r.declineReason = 'Replaced on the booking';
    }
  }

  // Any top-up the family still owes is left exactly where it is. This used to
  // set it to zero, silently wiping a balance that had nothing to do with who
  // the nanny is (it comes from a reschedule), with nothing left to show it
  // had ever been due.
  await booking.save();
  return { difference: 0, requiresPayment: false };
}

/**
 * The status a live booking should rest in, from where its days and money stand.
 *
 * Used wherever a booking is handed to a new nanny, so that "upcoming" is not
 * written over a booking that has already started, or over one still waiting
 * on money the family owes.
 */
export function restingStatus(booking) {
  if ((booking.additionalDue || 0) > 0) return BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT;
  const anyCompleted = (booking.serviceDays || []).some(
    (d) => d.status === SERVICE_DAY_STATUS.COMPLETED,
  );
  return anyCompleted ? BOOKING_STATUS.ONGOING : BOOKING_STATUS.UPCOMING;
}

/**
 * Release a confirmed booking to the nanny — or to both, on a 24h booking.
 *
 * A 24-hour booking is covered by two nannies in shifts. The family picks
 * both and pays for both, so both have to be asked. Until this existed each
 * approval path notified `booking.nanny` alone, and the second nanny never
 * heard about a job she had been booked and paid for.
 *
 * Shared by the single and bulk approval routes because they were drifting:
 * the same twenty lines written twice, and a fix to one never reached the
 * other.
 *
 * Returns the nannies actually asked, so the caller can log or report it.
 */
export async function releaseBookingToNannies(booking, family, notifyUser, messages) {
  if (booking.status !== BOOKING_STATUS.PENDING_PAYMENT) return [];

  // The pair, in the order the family chose them, with any blank slot dropped.
  const ids = [booking.nanny, booking.secondNanny].filter(Boolean);
  if (!ids.length) return [];

  const { setNannyRequestState } = await import('../flows/familyBookingPayment.js');
  const asked = [];

  for (const id of ids) {
    // Already a document when the caller populated it; an id otherwise.
    const nanny = id?._id ? id : await User.findById(id);
    if (!nanny) continue;

    const { expiresAt } = openNannyResponseWindow(booking, nanny._id, 'new_booking');
    asked.push({ nanny, expiresAt });
  }

  if (!asked.length) return [];

  // One save for both windows, then message them.
  booking.status = BOOKING_STATUS.UPCOMING;
  await booking.save();

  for (const { nanny, expiresAt } of asked) {
    await notifyUser(nanny, messages.nannyBookingRequest(booking, family, expiresAt, { nannyId: nanny._id }));
    await setNannyRequestState(nanny, booking);
  }

  return asked.map((a) => a.nanny);
}

export default {
  generateServiceCode, buildServiceDays, createBooking, recalcServiceDays,
  openNannyResponseWindow, pendingResponse, isInResponseWindow,
  releaseBookingToNannies,
  syncBookingStatus, cancelBooking, markNannyCancelled, assignReplacement,
};
