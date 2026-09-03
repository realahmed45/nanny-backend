import config from '../config/index.js';
import dayjs from 'dayjs';
import { DURATION_OPTIONS } from './constants.js';

export const money = (n, currency = config.currency) => {
  // IDR is written as a prefix with no decimals, e.g. Rp 90.000.
  const sym = currency === 'USD' ? '$' : currency === 'IDR' ? 'Rp ' : `${currency} `;
  const v = Number(n || 0);
  return `${sym}${v % 1 === 0 ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * Just the first name, for greetings.
 * "Ahmed Ali" -> "Ahmed". Addressing someone by their full name reads like a
 * form letter, not a conversation.
 */
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * What a family is shown for a nanny.
 *
 * Nannies give a nickname at signup and that is what families see: her legal
 * name is ours to verify, not theirs to know. Falls back to the first name
 * when no nickname was given, never the full name.
 */
export const nannyDisplayName = (nanny) =>
  String(nanny?.nickname || '').trim() || firstName(nanny?.fullName) || 'Your nanny';

export const prettyDate = (d) => (d ? dayjs(d).format('D MMMM') : '');
export const prettyDateFull = (d) => (d ? dayjs(d).format('D MMMM YYYY') : '');
export const prettyTime = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const mer = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${mer}`;
};

/** "9:00 AM – 11:00 AM" from a start time and a duration in hours. */
export const timeRange = (startTime, hours) => {
  if (!startTime) return '';
  const [h, m] = startTime.split(':').map(Number);
  const start = dayjs().hour(h).minute(m).second(0);
  const end = start.add(hours || 0, 'hour');
  return `${prettyTime(startTime)} – ${prettyTime(end.format('HH:mm'))}`;
};

/** Render a numbered menu from an array of labels. */
export const numbered = (items) => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** "Cooking ⭐4, Newborn Care ⭐5" */
export const ratedList = (items = []) =>
  items.map((i) => `${i.name} ⭐${i.rating ?? '-'}`).join(', ');

export const starLine = (n) => `⭐ ${Number(n || 0) % 1 === 0 ? Number(n || 0) : Number(n).toFixed(1)}`;

export const durationMenu = () =>
  DURATION_OPTIONS.map((h, i) => {
    const words = ['One Hour','Two Hours','Three Hours','Four Hours','Five Hours','Six Hours','Seven Hours','Eight Hours'];
    const label = h === 24 ? 'Full day 24 Hours.' : h === 12 ? '12 Hours' : words[i];
    return `${i + 1}. ${label}`;
  }).join('\n');

/** Child block used in every booking summary. */
export const childLines = (children = []) =>
  children.map((c, i) => {
    const icon = i % 2 === 0 ? '👧' : '👦';
    const med = c.medicalNotes && c.medicalNotes !== 'None' ? c.medicalNotes : 'No allergies';
    const diet = c.dietaryNotes && c.dietaryNotes !== 'None' ? c.dietaryNotes : 'No dietary restrictions';
    return `${icon} ${c.name} — ${c.age}\n • ${med}\n • ${diet}`;
  }).join('\n\n');

export const weekdayList = (days = []) => {
  if (!days.length) return '';
  if (days.length === 1) return days[0];
  return `${days.slice(0, -1).join(', ')} & ${days[days.length - 1]}`;
};

/** Human label for a booking status/sub-status pair. */
export const statusLabel = (booking) => {
  const map = {
    awaiting_nanny_confirmation: '🟠Upcoming - Awaiting Nanny Confirmation',
    nanny_confirmed: '🟢Upcoming - Nanny Confirmed',
    nanny_cancelled_awaiting_replacement: '🟠Nanny Cancelled – Replacement Needed',
    awaiting_change_confirmation: '🟠Awaiting Nanny Confirmation of Changes',
    awaiting_arrival: '🔵Ongoing - Awaiting Nanny Arrival Confirmation',
    arrival_confirmed: '🔵Ongoing - Nanny Arrival Confirmed',
    awaiting_end_of_service: '🔵Ongoing - Awaiting End of Service Confirmation',
    todays_service_completed: "🔵Ongoing - Today's Service Completed",
  };
  if (booking.subStatus && map[booking.subStatus]) return map[booking.subStatus];
  const base = {
    draft: 'Draft', pending_payment: '🟠Pending Payment',
    pending_additional_payment: '🟠Pending Additional Payment',
    upcoming: '🟠Upcoming', ongoing: '🔵Ongoing',
    completed: '🟢Completed', cancelled: '🔴Cancelled',
  };
  return base[booking.status] || booking.status;
};

export default {
  money, prettyDate, prettyDateFull, prettyTime, timeRange, numbered,
  ratedList, starLine, durationMenu, childLines, weekdayList, statusLabel,
};
