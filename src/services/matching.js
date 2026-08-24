import dayjs from 'dayjs';
import { User, Booking } from '../models/index.js';
import {
  USER_ROLE, NANNY_STATUS, CPR_REQUIREMENT, WEEKDAYS,
  BOOKING_STATUS, SERVICE_DAY_STATUS,
} from '../utils/constants.js';

/** Weekday name for an ISO date string, matching our Monday-first array. */
export function weekdayOf(dateStr) {
  const d = dayjs(dateStr);
  return WEEKDAYS[(d.day() + 6) % 7];
}

/**
 * Is the nanny free for every requested service day?
 * Checks her weekly availability, her blocked dates, her daily hour cap, and
 * any confirmed booking that overlaps the requested window.
 */
export async function isNannyAvailable(nanny, { serviceDays, hoursPerDay, excludeBookingId = null }) {
  const av = nanny.availability || {};
  const blocked = new Set(av.blockedDates || []);
  const availableDays = av.days || [];

  if (av.maxHoursPerDay && hoursPerDay > av.maxHoursPerDay) return false;

  for (const day of serviceDays) {
    if (blocked.has(day.date)) return false;
    if (availableDays.length && !availableDays.includes(weekdayOf(day.date))) return false;
  }

  // Reject overlaps with the nanny's existing live bookings.
  const query = {
    nanny: nanny._id,
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };

  const existing = await Booking.find(query).select('serviceDays').lean();
  for (const b of existing) {
    for (const ed of b.serviceDays || []) {
      if (ed.status === SERVICE_DAY_STATUS.CANCELLED || ed.status === SERVICE_DAY_STATUS.COMPLETED) continue;
      for (const nd of serviceDays) {
        const aStart = new Date(ed.startAt).getTime();
        const aEnd = new Date(ed.endAt).getTime();
        const bStart = new Date(nd.startAt).getTime();
        const bEnd = new Date(nd.endAt).getTime();
        if (aStart < bEnd && bStart < aEnd) return false;
      }
    }
  }
  return true;
}

/**
 * Find nannies matching a family's requirements.
 * Hard filters: verified, rate within budget, all required skills/languages,
 * CPR when required, subjects when tutoring is requested, and availability.
 * Results are ranked by rating, then distance, then rate.
 */
export async function findNannies({
  languages = [], skills = [], subjects = [],
  budgetMin = 0, budgetMax = Number.MAX_SAFE_INTEGER,
  cpr = CPR_REQUIREMENT.EITHER,
  serviceDays = [], hoursPerDay = 0,
  excludeIds = [], excludeBookingId = null,
  limit = 60,
}) {
  const query = {
    role: USER_ROLE.NANNY,
    nannyStatus: NANNY_STATUS.VERIFIED,
    blocked: { $ne: true },
    registrationComplete: true,
  };

  if (budgetMax) query.hourlyRate = { $gte: 0, $lte: budgetMax };
  if (cpr === CPR_REQUIREMENT.REQUIRED) query.cprCertified = true;
  if (skills.length) query['skills.name'] = { $all: skills };
  if (languages.length) query['languages.name'] = { $all: languages };
  if (subjects.length && skills.includes('Tutoring')) query.subjects = { $all: subjects };
  if (excludeIds.length) query._id = { $nin: excludeIds };

  const candidates = await User.find(query).limit(limit * 3);

  const available = [];
  for (const n of candidates) {
    if (serviceDays.length) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await isNannyAvailable(n, { serviceDays, hoursPerDay, excludeBookingId });
      if (!ok) continue;
    }
    available.push(n);
  }

  available.sort((a, b) =>
    (b.ratingAverage || 0) - (a.ratingAverage || 0) ||
    (a.distanceKm ?? 99) - (b.distanceKm ?? 99) ||
    (a.hourlyRate || 0) - (b.hourlyRate || 0)
  );

  return available.slice(0, limit);
}

/** Re-run matching for an existing booking (used for replacements). */
export async function findReplacements(booking, { includeOverBudget = false } = {}) {
  const req = booking.requirements || {};
  const remaining = booking.remainingDays();
  return findNannies({
    languages: req.languages || [],
    skills: req.skills || [],
    subjects: req.subjects || [],
    budgetMin: req.budgetMin,
    budgetMax: includeOverBudget ? Number.MAX_SAFE_INTEGER : req.budgetMax,
    cpr: req.cpr,
    serviceDays: remaining,
    hoursPerDay: booking.hoursPerDay,
    excludeIds: [...(booking.rejectedNannies || []), booking.nanny].filter(Boolean),
    excludeBookingId: booking._id,
  });
}

export default { findNannies, findReplacements, isNannyAvailable, weekdayOf };
