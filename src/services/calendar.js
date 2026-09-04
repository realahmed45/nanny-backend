import { getSettings } from './settings.js';

/**
 * The service calendar: days that are priced differently, and days nobody
 * works at all.
 *
 * Bali's calendar has days that genuinely change what the platform can offer.
 * Nyepi, the day of silence, is the sharpest case: for twenty-four hours
 * nobody leaves the house, the airport closes, and lights stay off. A nanny
 * cannot travel to a booking, so a booking on that date is not a booking that
 * can be honoured — it has to be refused when it is made, not apologised for
 * on the day.
 */

/** A YYYY-MM-DD calendar date. Times and zones are deliberately not involved. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CALENDAR_DEFAULTS = {
  /** Dates with their own multiplier or closure, newest settings win. */
  specialDays: [],
  nyepi: {
    enabled: true,
    /**
     * Nyepi moves every year with the Balinese Saka calendar, so the dates are
     * entered by an admin rather than derived. Seeded with the known dates so
     * the rule works out of the box.
     */
    dates: ['2026-03-19', '2027-03-08', '2028-02-26'],
    /** Nobody can work, so bookings are refused rather than accepted and cancelled. */
    blockBookings: true,
    /** Melasti/eve: travel is already restricted and demand is unusual. */
    eveDate: null,
    eveMultiplier: 1,
    /** Ngembak Geni, the day after: everyone travels at once. */
    dayAfterMultiplier: 1,
    notice: '',
  },
};

/** Local YYYY-MM-DD for a date, without dragging UTC into a calendar question. */
export function isoDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Add whole days to a YYYY-MM-DD string, staying in calendar terms. */
function shiftDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return isoDate(dt);
}

export async function getCalendar() {
  const settings = await getSettings();
  const stored = settings.calendar || {};
  return {
    ...CALENDAR_DEFAULTS,
    ...stored,
    nyepi: { ...CALENDAR_DEFAULTS.nyepi, ...(stored.nyepi || {}) },
  };
}

/**
 * What applies on one date.
 *
 * Returns a multiplier and, when the day is closed, the reason to show the
 * family. Nyepi is checked before the manual list so an admin cannot
 * accidentally sell a day that cannot be worked.
 */
export function describeDay(date, calendar) {
  const iso = ISO_DATE.test(String(date)) ? String(date) : isoDate(date);
  const cal = calendar || CALENDAR_DEFAULTS;
  const nyepi = { ...CALENDAR_DEFAULTS.nyepi, ...(cal.nyepi || {}) };

  if (!iso) return { date: null, multiplier: 1, closed: false };

  if (nyepi.enabled && (nyepi.dates || []).includes(iso)) {
    return {
      date: iso,
      multiplier: 1,
      closed: !!nyepi.blockBookings,
      isNyepi: true,
      label: 'Nyepi (Day of Silence)',
      reason: nyepi.notice
        || 'Nyepi is Bali’s day of silence. Nobody may travel or work, so we cannot arrange care on this date.',
    };
  }

  // The eve and the day after are workable, but priced apart from a normal day.
  if (nyepi.enabled) {
    const eve = nyepi.eveDate
      || (nyepi.dates || []).map((d) => shiftDays(d, -1)).find((d) => d === iso);
    if (eve === iso && Number(nyepi.eveMultiplier) !== 1) {
      return {
        date: iso, multiplier: Number(nyepi.eveMultiplier) || 1, closed: false,
        label: 'Nyepi eve (Melasti)',
      };
    }
    const dayAfter = (nyepi.dates || []).map((d) => shiftDays(d, 1)).find((d) => d === iso);
    if (dayAfter === iso && Number(nyepi.dayAfterMultiplier) !== 1) {
      return {
        date: iso, multiplier: Number(nyepi.dayAfterMultiplier) || 1, closed: false,
        label: 'Ngembak Geni (day after Nyepi)',
      };
    }
  }

  const special = (cal.specialDays || []).find((d) => d.date === iso);
  if (special) {
    return {
      date: iso,
      multiplier: special.closed ? 1 : Number(special.multiplier) || 1,
      closed: !!special.closed,
      label: special.label || 'Special day',
      reason: special.closed ? `We are not taking bookings on ${iso}.` : undefined,
    };
  }

  return { date: iso, multiplier: 1, closed: false };
}

/** Convenience: is this date bookable at all? */
export async function checkDateBookable(date) {
  const day = describeDay(date, await getCalendar());
  return { ok: !day.closed, ...day };
}

/** Every closed or surcharged day in a range, for the dashboard calendar grid. */
export function daysInRange(from, to, calendar) {
  const out = [];
  let cursor = ISO_DATE.test(String(from)) ? String(from) : isoDate(from);
  const end = ISO_DATE.test(String(to)) ? String(to) : isoDate(to);
  // Guard against an inverted or malformed range spinning forever.
  let guard = 0;
  while (cursor && end && cursor <= end && guard < 800) {
    const day = describeDay(cursor, calendar);
    if (day.closed || day.multiplier !== 1) out.push(day);
    cursor = shiftDays(cursor, 1);
    guard += 1;
  }
  return out;
}

export default { getCalendar, describeDay, checkDateBookable, daysInRange, CALENDAR_DEFAULTS, ISO_DATE };
