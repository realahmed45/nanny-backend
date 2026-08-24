// Cancellation / refund / pricing policy engine.
// Source of truth: "My Nanny CANCELLATION & REFUND POLICY" in the chatbot script.
import config from '../config/index.js';
import { CANCELLED_BY } from '../utils/constants.js';

/**
 * Family-cancels refund split for a SINGLE-DAY booking, by hours of notice.
 *   48+ h   -> 100% family / 0% nanny
 *   36-47 h ->  50% / 50%
 *   <36 h   ->   0% / 100%
 */
export function singleDaySplit(hoursBefore) {
  if (hoursBefore >= 48) return { familyRefundPct: 100, nannyCompensationPct: 0, band: '48+ hours' };
  if (hoursBefore >= 36) return { familyRefundPct: 50, nannyCompensationPct: 50, band: '36-47 hours' };
  return { familyRefundPct: 0, nannyCompensationPct: 100, band: 'under 36 hours' };
}

/**
 * Family-cancels refund split for a MULTI-DAY booking, by days of notice
 * relative to each affected (uncompleted) service day.
 *   5+ days -> 100/0 ; 4-5 days -> 50/50 ; 2-3 days -> 25/75 ; <=24h -> 0/100
 * Note: the spec's bands overlap at "4-5"; we treat >=5 as 100% (the more
 * generous reading, checked first) and 4 as the 50/50 band.
 */
export function multiDaySplit(hoursBefore) {
  const days = hoursBefore / 24;
  if (days >= 5) return { familyRefundPct: 100, nannyCompensationPct: 0, band: '5+ days' };
  if (days >= 4) return { familyRefundPct: 50, nannyCompensationPct: 50, band: '4-5 days' };
  if (days >= 2) return { familyRefundPct: 25, nannyCompensationPct: 75, band: '2-3 days' };
  return { familyRefundPct: 0, nannyCompensationPct: 100, band: '24 hours or less' };
}

/**
 * Compute the refund for cancelling a booking.
 *
 * Rules implemented:
 *  - Completed service days are never refundable and are always payable to the nanny.
 *  - Only affected / uncompleted days are subject to the policy table.
 *  - Nanny-cancels and Admin-cancels => 100% refund of remaining days, 0% nanny comp.
 *  - Family-cancels => per-day band based on notice before THAT day's start.
 *
 * @param {object} booking  Booking document (needs serviceDays[], amounts).
 * @param {object} opts     { cancelledBy, at = new Date(), dayIds? }
 * @returns {{ totalRefund, totalNannyCompensation, perDay: [], completedAmount }}
 */
export function computeCancellationRefund(booking, opts = {}) {
  const at = opts.at ? new Date(opts.at) : new Date();
  const cancelledBy = opts.cancelledBy || CANCELLED_BY.FAMILY;
  const isMultiDay = (booking.serviceDays || []).length > 1;

  const perDay = [];
  let totalRefund = 0;
  let totalNannyCompensation = 0;
  let completedAmount = 0;

  for (const day of booking.serviceDays || []) {
    const dayAmount = round2(day.amount ?? 0);

    // Completed (or already-cancelled) days are settled and not refundable.
    if (day.status === 'completed') {
      completedAmount += dayAmount;
      totalNannyCompensation += dayAmount;
      perDay.push({
        dayId: String(day._id ?? ''), date: day.date, amount: dayAmount,
        familyRefund: 0, nannyCompensation: dayAmount, band: 'completed (not refundable)',
      });
      continue;
    }
    if (day.status === 'cancelled') continue;

    // Restrict to specific days when the caller asks for a partial cancellation.
    if (opts.dayIds && !opts.dayIds.map(String).includes(String(day._id))) continue;

    let split;
    if (cancelledBy === CANCELLED_BY.NANNY || cancelledBy === CANCELLED_BY.ADMIN || cancelledBy === CANCELLED_BY.SYSTEM) {
      // Nanny/Admin cancel: family gets 100% of incomplete days, nanny gets nothing.
      split = { familyRefundPct: 100, nannyCompensationPct: 0, band: `${cancelledBy} cancelled` };
    } else {
      const hoursBefore = (new Date(day.startAt) - at) / 36e5;
      split = isMultiDay ? multiDaySplit(hoursBefore) : singleDaySplit(hoursBefore);
    }

    const familyRefund = round2((dayAmount * split.familyRefundPct) / 100);
    const nannyCompensation = round2(dayAmount - familyRefund);

    totalRefund += familyRefund;
    totalNannyCompensation += nannyCompensation;
    perDay.push({
      dayId: String(day._id ?? ''), date: day.date, amount: dayAmount,
      familyRefund, nannyCompensation, band: split.band,
    });
  }

  return {
    totalRefund: round2(totalRefund),
    totalNannyCompensation: round2(totalNannyCompensation),
    completedAmount: round2(completedAmount),
    perDay,
  };
}

/**
 * Reschedule penalty. Spec: 5% penalty, applied only to the day(s) being
 * rescheduled, and only after the free reschedule allowance is exhausted
 * (more than 3 reschedules on an ongoing multi-day booking).
 */
export function computeReschedulePenalty(booking, dayIds = []) {
  const used = booking.rescheduleCount || 0;
  const free = used < config.freeRescheduleLimit;
  const days = (booking.serviceDays || []).filter(
    (d) => dayIds.map(String).includes(String(d._id)) && d.status !== 'completed'
  );
  const base = days.reduce((s, d) => s + (d.amount || 0), 0);
  const penalty = free ? 0 : round2((base * config.reschedulePenaltyPercent) / 100);
  return {
    penalty,
    free,
    reschedulesUsed: used,
    freeLimit: config.freeRescheduleLimit,
    percent: free ? 0 : config.reschedulePenaltyPercent,
    affectedAmount: round2(base),
  };
}

/**
 * Overtime rounding. Spec: 15+ mins => 30 mins charged; 45+ mins => 1 hour charged.
 * Generalised so every started 30-minute block beyond a 15-minute grace is charged.
 */
export function computeOvertimeHours(extraMinutes) {
  if (!extraMinutes || extraMinutes < 15) return 0;
  const fullHours = Math.floor(extraMinutes / 60);
  const remainder = extraMinutes % 60;
  let hours = fullHours;
  if (remainder >= 45) hours += 1;
  else if (remainder >= 15) hours += 0.5;
  return hours;
}

/** Booking total = hourlyRate * hoursPerDay * numberOfDays. */
export function computeBookingAmount({ hourlyRate, hoursPerDay, days }) {
  return round2(hourlyRate * hoursPerDay * days);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export default {
  singleDaySplit, multiDaySplit, computeCancellationRefund,
  computeReschedulePenalty, computeOvertimeHours, computeBookingAmount, round2,
};
