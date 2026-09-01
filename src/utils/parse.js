import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { COMMANDS, WEEKDAYS } from './constants.js';

dayjs.extend(customParseFormat);

export function clean(text = '') {
  return String(text ?? '').trim();
}

export function lower(text = '') {
  return clean(text).toLowerCase();
}

/** Detect a global command (SKIP / 0 / NEXT / BYE / CANCEL / BACK / NONE). */
export function detectCommand(text) {
  const t = lower(text);
  if (t === COMMANDS.MAIN_MENU) return 'MAIN_MENU';
  if (t === COMMANDS.SKIP) return 'SKIP';
  if (t === COMMANDS.NEXT) return 'NEXT';
  if (t === COMMANDS.BYE) return 'BYE';
  if (t === COMMANDS.CANCEL) return 'CANCEL';
  if (t === COMMANDS.BACK) return 'BACK';
  if (t === COMMANDS.NONE) return 'NONE';
  return null;
}

export function isNone(text) {
  return lower(text) === 'none';
}

/** Parse a single menu choice: "2" -> 2, out-of-range -> null. */
export function parseChoice(text, max) {
  const t = clean(text);
  if (!/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  if (n < 1 || (max && n > max)) return null;
  return n;
}

/** Parse a multi-select like "1,3,4" into unique in-range 1-based indices. */
/**
 * A child's age, accepted loosely and stored consistently.
 *
 * Families type "4", "4y", "4 yrs", "4 years" and every spacing in between, so
 * the summary ended up with a mix of "15 years" and "10y". Anything that boils
 * down to a plain number of years is normalised to "N years"; months are kept
 * separately because a 6-month-old is not the same as a 6-year-old.
 *
 * Returns a display string, or null when it cannot be read as an age.
 */
export function parseChildAge(text) {
  const t = clean(text).toLowerCase().replace(/[.,]/g, ' ').trim();
  if (!t) return null;

  // Months first: "6 months", "6m", "6 mo".
  const months = /^(\d{1,2})\s*(m|mo|mos|month|months)$/.exec(t);
  if (months) {
    const n = parseInt(months[1], 10);
    if (n < 1 || n > 23) return null;
    return `${n} month${n === 1 ? '' : 's'}`;
  }

  // Years: bare number, or with any of the usual suffixes.
  const years = /^(\d{1,2})\s*(y|yr|yrs|year|years|yo)?$/.exec(t);
  if (years) {
    const n = parseInt(years[1], 10);
    if (n < 0 || n > 18) return null;
    if (n === 0) return 'under 1 year';
    return `${n} year${n === 1 ? '' : 's'}`;
  }

  return null;
}

export function parseMultiChoice(text, max) {
  const parts = clean(text).split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n < 1 || n > max) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Map 1-based selections onto a catalog array. */
export function pickFrom(catalog, indices) {
  return indices.map((i) => catalog[i - 1]).filter(Boolean);
}

export function parseYesNo(text) {
  const t = lower(text);
  if (['1', 'yes', 'y', 'yeah', 'yep', 'ok', 'okay'].includes(t)) return true;
  if (['2', 'no', 'n', 'nope'].includes(t)) return false;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function parseEmail(text) {
  // Tolerate WhatsApp/markdown auto-links: [a@b.com](mailto:a@b.com)
  let t = clean(text);
  const md = t.match(/\(mailto:([^)]+)\)/i);
  if (md) t = md[1];
  t = t.replace(/^<|>$/g, '').trim();
  return EMAIL_RE.test(t) ? t.toLowerCase() : null;
}

/** Money input: "$25", "25 USD", "25.50" -> 25 / 25.5 */
export function parseMoney(text) {
  const t = clean(text).replace(/[^0-9.]/g, '');
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseInteger(text, { min = 0, max = Infinity } = {}) {
  const t = clean(text).replace(/[^0-9]/g, '');
  if (!t) return null;
  const n = parseInt(t, 10);
  return n >= min && n <= max ? n : null;
}

/**
 * Parse a time like "9 AM", "9:00 AM", "21:30", "9am" -> "HH:mm" (24h).
 */
export function parseTime(text) {
  const t = clean(text).toUpperCase().replace(/\./g, '');
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (minute > 59) return null;
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    if (mer === 'AM') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Parse a date the way families type it in the script: "12 August",
 * "12 Aug 2026", "2026-08-12", "12/08/2026". Bare day+month resolves to the
 * next such date at or after `reference` (so "12 August" never lands in the past).
 */
export const WEEKDAY_NAMES = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

/**
 * A date the family typed, in whatever shape they typed it.
 *
 * Handles three kinds of answer:
 *   - relative words: today, tomorrow, tmrw, day after tomorrow
 *   - weekday names: "monday" means the *next* Monday, never today's date if
 *     today happens to be Monday, because someone asking on Monday for
 *     "monday" means the coming one
 *   - explicit dates: 12 August, 12 aug, August 12, 12/08, 2026-08-12
 *
 * Bare month/day answers roll into next year when the date has passed, so
 * "12 August" asked in September means next August rather than a date in the
 * past. Returns YYYY-MM-DD, or null when it cannot be read as a date.
 */
export function parseDate(text, reference = new Date()) {
  const t = clean(text).toLowerCase().replace(/[.,]+$/, '').trim();
  if (!t) return null;
  const ref = dayjs(reference).startOf('day');

  // --- relative words ---
  if (/^(today|tonight|now)$/.test(t)) return ref.format('YYYY-MM-DD');
  if (/^(tomorrow|tmrw|tmw|tom)$/.test(t)) return ref.add(1, 'day').format('YYYY-MM-DD');
  if (/^(day after tomorrow|overmorrow)$/.test(t)) return ref.add(2, 'day').format('YYYY-MM-DD');

  // --- weekday names: always the next one, never today ---
  const weekday = /^(next\s+|this\s+|coming\s+)?([a-z]+)$/.exec(t);
  if (weekday) {
    const name = weekday[2];
    const idx = WEEKDAY_NAMES.findIndex(
      (w) => w === name || (name.length >= 3 && w.startsWith(name.slice(0, 3))),
    );
    if (idx !== -1) {
      let diff = (idx - ref.day() + 7) % 7;
      if (diff === 0) diff = 7;        // "monday" on a Monday means next Monday
      return ref.add(diff, 'day').format('YYYY-MM-DD');
    }
  }

  // dayjs matches month names case-sensitively, so restore title case
  // before trying the formats: "12 august" must parse like "12 August".
  const cased = t.replace(/(^|\s)([a-z])/g, (m, sp, c) => sp + c.toUpperCase());

  // --- explicit dates, full year given ---
  const withYear = [
    'YYYY-MM-DD', 'YYYY/MM/DD',
    'D MMMM YYYY', 'D MMM YYYY', 'MMMM D YYYY', 'MMM D YYYY',
    'DD/MM/YYYY', 'D/M/YYYY', 'DD-MM-YYYY', 'D-M-YYYY',
  ];
  for (const f of withYear) {
    const d = dayjs(cased, f, true);
    if (d.isValid()) return d.format('YYYY-MM-DD');
  }

  // --- day and month only: assume the next occurrence ---
  const withoutYear = [
    'D MMMM', 'D MMM', 'MMMM D', 'MMM D',
    'D/M', 'DD/MM', 'D-M', 'DD-MM',
  ];
  for (const f of withoutYear) {
    const d = dayjs(cased, f, true);
    if (d.isValid()) {
      let candidate = d.year(ref.year());
      if (candidate.isBefore(ref, 'day')) candidate = candidate.add(1, 'year');
      return candidate.format('YYYY-MM-DD');
    }
  }

  // Deliberately no loose fallback: dayjs happily reads "12 augustus" as the
  // year 2001, which silently produced dates nobody asked for.
  return null;
}


/** Parse weekday selection: "1,2,3" or "Monday, Tuesday". */
export function parseWeekdays(text) {
  const t = clean(text);
  if (!t) return null;

  if (/^[\d,\s]+$/.test(t)) {
    // 8 is the "All days of the week" shortcut, so it cannot be combined with
    // individual days — picking it means every day.
    const idx = parseMultiChoice(t, 8);
    if (!idx) return null;
    if (idx.includes(8)) return [...WEEKDAYS];
    return pickFrom(WEEKDAYS, idx);
  }

  // Written days: accept commas, "and", or plain spaces between them.
  if (/^(all|every ?day|everyday|all days|daily)$/i.test(t)) return [...WEEKDAYS];

  const names = t
    .split(/[,&]+|\s+and\s+|\s+/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const out = [];
  for (const n of names) {
    const match = WEEKDAYS.find(
      (w) => w.toLowerCase() === n || (n.length >= 3 && w.toLowerCase().startsWith(n.slice(0, 3))),
    );
    if (!match) return null;
    if (!out.includes(match)) out.push(match);
  }
  return out.length ? out : null;
}

/** Accept a Google Maps / any http(s) URL, or "None". */
export function parseMapUrl(text) {
  const t = clean(text);
  if (isNone(t)) return { none: true, url: null };
  if (/^https?:\/\/\S+$/i.test(t)) return { none: false, url: t };
  return null;
}

export function parseOtp(text) {
  const t = clean(text).replace(/\s/g, '');
  return /^\d{6}$/.test(t) ? t : null;
}

/** Arrival / end-of-service codes in the script look like "A123". */
export function parseServiceCode(text) {
  const t = clean(text).toUpperCase().replace(/\s/g, '');
  return /^[A-Z0-9]{4,6}$/.test(t) ? t : null;
}

export default {
  clean, lower, detectCommand, isNone, parseChoice, parseMultiChoice, pickFrom,
  parseYesNo, parseEmail, parseMoney, parseInteger, parseTime, parseDate,
  parseWeekdays, parseMapUrl, parseOtp, parseServiceCode,
};
