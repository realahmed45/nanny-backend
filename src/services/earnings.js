import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import { Booking, User } from '../models/index.js';
import { BOOKING_STATUS, SERVICE_DAY_STATUS } from '../utils/constants.js';
import { dayEarnings, dayCommission, rateForDay } from './payments.js';
import { round2 } from './policy.js';

dayjs.extend(isoWeek);

/**
 * What the business actually made, and what it owes.
 *
 * Two numbers meet on every booking and must never be confused:
 *
 *   what the family paid  — the platform's rate card: children, holiday
 *                           multipliers, any discount. Nothing to do with
 *                           which nanny was booked.
 *   what the nanny is paid — her own agreed rate, settled with the office
 *                           when she registered. A family never sees it.
 *
 * Commission is the difference. It is derived here rather than stored as its
 * own rate, so it can never disagree with what was really charged and really
 * paid — if either side changes, the commission follows automatically.
 *
 * Everything below counts **completed days only**. A day that has not been
 * worked has not earned anything, and counting scheduled work as revenue is
 * how a dashboard ends up lying about the bank balance.
 */

/** Days that have actually been worked. */
function completedDays(booking) {
  return (booking.serviceDays || []).filter(
    (d) => d.status === SERVICE_DAY_STATUS.COMPLETED,
  );
}

/**
 * The money on one booking: charged, paid out, kept.
 *
 * `nannyCompensation` is included in what we pay out because it is real money
 * leaving the business — a nanny compensated for a late family cancellation
 * is owed it whether or not she worked.
 */
export function bookingEarnings(booking) {
  const days = completedDays(booking);

  let charged = 0;
  let paidToNannies = 0;

  for (const day of days) {
    const rate = rateForDay(booking, day);
    charged += round2((day.amount || 0) + (day.overtimeAmount || 0));
    paidToNannies += dayEarnings(booking, day, rate);
  }

  // Compensation for cancelled days: paid to her, never charged to anyone.
  const compensation = (booking.serviceDays || [])
    .reduce((sum, d) => sum + (d.nannyCompensation || 0), 0);

  charged = round2(charged);
  paidToNannies = round2(paidToNannies + compensation);

  return {
    bookingId: booking._id,
    bookingNumber: booking.bookingNumber,
    completedDays: days.length,
    charged,
    paidToNannies,
    compensation: round2(compensation),
    // Refunds already sent come off what we kept — that money went back.
    refunded: round2(booking.refundedAmount || 0),
    commission: round2(charged - paidToNannies - (booking.refundedAmount || 0)),
    // Flagged rather than silently zeroed: a booking with no recorded nanny
    // rate cannot be settled, and someone has to notice.
    missingNannyRate: days.length > 0 && !booking.nannyHourlyRate,
  };
}

/**
 * Commission across a date range, for the dashboard's earnings page.
 *
 * Ranged on the day the work was completed rather than when the booking was
 * created, because that is when the money was actually earned.
 */
export async function earningsSummary({ from, to } = {}) {
  const start = from ? dayjs(from).startOf('day') : dayjs().startOf('month');
  const end = to ? dayjs(to).endOf('day') : dayjs().endOf('day');

  const bookings = await Booking.find({
    status: { $in: [BOOKING_STATUS.ONGOING, BOOKING_STATUS.COMPLETED] },
    'serviceDays.status': SERVICE_DAY_STATUS.COMPLETED,
  })
    .populate('nanny', 'fullName nickname phone hourlyRate')
    .populate('family', 'fullName phone')
    .lean({ virtuals: false });

  const rows = [];
  const totals = { charged: 0, paidToNannies: 0, commission: 0, refunded: 0, bookings: 0, days: 0 };
  const unpriced = [];

  for (const booking of bookings) {
    // Inclusive at both ends. `isAfter`/`isBefore` are strict, so a day landing
    // exactly on a boundary — midnight at the start, the final millisecond at
    // the end — was dropped from the period entirely.
    const within = (when) => when
      && !dayjs(when).isBefore(start)
      && !dayjs(when).isAfter(end);

    // Only the days worked inside the window count toward this period.
    const inRange = completedDays(booking).filter(
      (d) => within(d.endConfirmedAt || d.endAt),
    );

    /**
     * Cancelled days in the window, for their compensation alone.
     *
     * `nannyCompensation` is only ever written on a cancelled day, so scoping
     * the booking to completed days meant it was always zero here: real money
     * paid to a nanny never appeared in "paid to nannies", and the commission
     * for the period read higher than it was.
     */
    const compensated = (booking.serviceDays || []).filter(
      (d) => (d.nannyCompensation || 0) > 0 && within(d.cancelledAt || d.startAt),
    );

    if (!inRange.length && !compensated.length) continue;

    const scoped = { ...booking, serviceDays: [...inRange, ...compensated] };
    const money = bookingEarnings(scoped);

    if (money.missingNannyRate) {
      unpriced.push({
        bookingNumber: booking.bookingNumber,
        nanny: booking.nanny?.fullName || 'Unknown',
      });
    }

    rows.push({
      ...money,
      nanny: booking.nanny?.fullName || booking.nanny?.nickname || '—',
      family: booking.family?.fullName || '—',
      // The ids as well as the names: two families can share a name, and
      // grouping revenue by a display string would silently merge them.
      nannyId: booking.nanny?._id ? String(booking.nanny._id) : null,
      familyId: booking.family?._id ? String(booking.family._id) : null,
      nannyHourlyRate: booking.nannyHourlyRate || 0,
      familyHourlyRate: booking.hourlyRate || 0,
    });

    totals.charged += money.charged;
    totals.paidToNannies += money.paidToNannies;
    totals.commission += money.commission;
    totals.refunded += money.refunded;
    totals.days += money.completedDays;
    totals.bookings += 1;
  }

  for (const key of ['charged', 'paidToNannies', 'commission', 'refunded']) {
    totals[key] = round2(totals[key]);
  }

  // Biggest earners first — the useful order for a page someone scans.
  rows.sort((a, b) => b.commission - a.commission);

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    totals,
    rows,
    // Bookings that cannot be settled because no nanny rate was recorded.
    // Surfaced deliberately: the totals are wrong until these are fixed.
    unpriced,
  };
}

/**
 * Whether a nanny on a contract has been given the work she was promised.
 *
 * A guarantee is a guarantee: if she is contracted for 40 hours and we only
 * booked her for 30, she is owed 40 and the shortfall comes out of the
 * business. This reports that in advance, so the gap can be closed with real
 * work instead of paid as dead money.
 *
 * Hours and visits are counted separately on purpose — she can make her hours
 * across four visits and still be a visit short.
 */
export async function contractStatus(nannyId, { weekOf = new Date() } = {}) {
  const nanny = await User.findById(nannyId)
    .select('fullName nickname hourlyRate contract')
    .lean();
  if (!nanny) return null;

  const contract = nanny.contract || {};
  const minHours = Number(contract.minimumHoursPerWeek || 0);
  const minShifts = Number(contract.minimumShiftsPerWeek || 0);
  const buffer = Number(contract.safetyBufferPercent ?? 20);

  const start = dayjs(weekOf).startOf('isoWeek');
  const end = dayjs(weekOf).endOf('isoWeek');

  // Everything she is actually committed to this week: worked, or still to
  // come. A cancelled day is not work and does not count toward her minimum.
  const bookings = await Booking.find({
    $or: [{ nanny: nannyId }, { secondNanny: nannyId }],
    status: { $ne: BOOKING_STATUS.CANCELLED },
  }).select('serviceDays nanny secondNanny').lean();

  let hours = 0;
  const shiftDays = new Set();

  for (const booking of bookings) {
    for (const day of booking.serviceDays || []) {
      if (day.status === SERVICE_DAY_STATUS.CANCELLED) continue;

      // Inclusive at both ends. `isAfter` is strict against Monday 00:00:00,
      // so a live-in or 24h booking starting at exactly midnight lost every
      // Monday from her hours — understating what she worked and inflating
      // the guarantee shortfall the business believes it owes her for it.
      const at = dayjs(day.startAt);
      if (at.isBefore(start) || at.isAfter(end)) continue;

      // After a replacement the day belongs to whoever actually has it.
      const worker = String(day.nanny || booking.nanny || '');
      if (worker && worker !== String(nannyId)) continue;

      hours += Number(day.hours || 0) + Number(day.overtimeHours || 0);
      // A visit is one client on one day; two shifts for different families
      // on the same day are two visits.
      shiftDays.add(`${day.date}:${String(booking._id)}`);
    }
  }

  const shifts = shiftDays.size;
  const hourShortfall = Math.max(0, round2(minHours - hours));
  const shiftShortfall = Math.max(0, minShifts - shifts);

  return {
    nanny: {
      id: nanny._id,
      name: nanny.fullName || nanny.nickname,
      hourlyRate: nanny.hourlyRate || 0,
      // Whether the signed agreement is on file. Not the URL: the list is
      // a scan of who is missing paperwork, and the file itself is only
      // needed once you open the one you care about.
      hasContractDoc: Boolean(nanny.contract?.documentUrl),
    },
    weekStart: start.format('YYYY-MM-DD'),
    weekEnd: end.format('YYYY-MM-DD'),
    onContract: minHours > 0 || minShifts > 0,
    hours: { booked: round2(hours), minimum: minHours, target: round2(minHours * (1 + buffer / 100)), shortfall: hourShortfall },
    shifts: { booked: shifts, minimum: minShifts, target: Math.ceil(minShifts * (1 + buffer / 100)), shortfall: shiftShortfall },
    safetyBufferPercent: buffer,
    // What we would have to pay for work that was never done, if the week
    // ended now. The number the office is trying to keep at zero.
    guaranteeShortfallCost: round2(hourShortfall * (nanny.hourlyRate || 0)),
    meetsContract: hourShortfall === 0 && shiftShortfall === 0,
  };
}

/** Contract status for every nanny who is on one. */
export async function contractStatusAll({ weekOf = new Date() } = {}) {
  const contracted = await User.find({
    role: 'nanny',
    $or: [
      { 'contract.minimumHoursPerWeek': { $gt: 0 } },
      { 'contract.minimumShiftsPerWeek': { $gt: 0 } },
    ],
  }).select('_id').lean();

  const rows = [];
  for (const { _id } of contracted) {
    const status = await contractStatus(_id, { weekOf });
    if (status) rows.push(status);
  }

  // Those furthest from their guarantee first — the ones needing work found.
  rows.sort((a, b) => b.guaranteeShortfallCost - a.guaranteeShortfallCost);
  return rows;
}

export default {
  bookingEarnings, earningsSummary, contractStatus, contractStatusAll,
};
