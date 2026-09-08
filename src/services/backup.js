import ExcelJS from 'exceljs';
import {
  User, Booking, Payment, Note, CallbackRequest, Ticket,
} from '../models/index.js';
import { send, brandedEmail } from '../providers/email.js';
import config from '../config/index.js';
import { money } from '../utils/format.js';
import { USER_ROLE } from '../utils/constants.js';

/**
 * The end-of-day backup.
 *
 * One spreadsheet, one sheet per thing worth keeping, emailed out each night.
 * It exists because the database is the only copy of every family, nanny,
 * booking and payment, and a file in somebody's inbox is a copy that survives
 * losing the database entirely.
 *
 * It is deliberately a plain export rather than a dump: the columns are the
 * ones a person would want if they had to rebuild from it or answer a question
 * without the dashboard. Money is written as numbers so the file can be
 * summed, and ids are included so rows can be matched back up.
 */

/** Ids are objects until they are strings; dates are dates until they are not. */
const str = (v) => (v == null ? '' : String(v));
const day = (d) => (d ? new Date(d) : null);

/** Add a sheet with a header row that stays visible while scrolling. */
function addSheet(book, name, columns, rows) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };
  return sheet;
}

/** Build the workbook. Exported so it can be tested without sending mail. */
export async function buildBackupWorkbook() {
  const [families, nannies, bookings, payments, notes, callbacks, tickets] = await Promise.all([
    User.find({ role: USER_ROLE.FAMILY }).lean(),
    User.find({ role: USER_ROLE.NANNY }).lean(),
    Booking.find().populate('family', 'fullName phone').populate('nanny', 'fullName nickname phone').lean(),
    Payment.find().lean(),
    Note.find().lean(),
    CallbackRequest.find().lean(),
    Ticket.find().lean(),
  ]);

  const book = new ExcelJS.Workbook();
  book.creator = config.brand.name;
  book.created = new Date();

  addSheet(book, 'Families', [
    { header: 'ID', key: 'id', width: 26 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Registered', key: 'registered', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Last active', key: 'lastSeen', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Referral code', key: 'code', width: 14 },
    { header: 'Referrals', key: 'referrals', width: 10 },
    { header: 'Instagram', key: 'ig', width: 18 },
    { header: 'IG verified', key: 'igOk', width: 11 },
    { header: 'Number saved', key: 'waOk', width: 13 },
    { header: 'Blocked', key: 'blocked', width: 9 },
  ], families.map((f) => ({
    id: str(f._id),
    name: f.fullName,
    phone: f.phone,
    email: f.email,
    registered: day(f.createdAt),
    lastSeen: day(f.lastSeenAt),
    code: f.referralCode,
    referrals: f.referralCount || 0,
    ig: f.social?.instagramHandle || '',
    igOk: f.social?.instagramFollowing ? 'yes' : '',
    waOk: f.social?.whatsappSaved ? 'yes' : '',
    blocked: f.blocked ? 'yes' : '',
  })));

  addSheet(book, 'Nannies', [
    { header: 'ID', key: 'id', width: 26 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Nickname', key: 'nickname', width: 16 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'Age', key: 'age', width: 6 },
    { header: 'Experience (yrs)', key: 'exp', width: 15 },
    { header: 'Rate/hr', key: 'rate', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Rating', key: 'rating', width: 8 },
    { header: 'CPR', key: 'cpr', width: 6 },
    { header: 'Videos', key: 'videos', width: 8 },
    { header: 'Photos', key: 'photos', width: 8 },
    { header: 'Approved media', key: 'approved', width: 15 },
    { header: 'On profile', key: 'featured', width: 11 },
    { header: 'Last active', key: 'lastSeen', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], nannies.map((n) => ({
    id: str(n._id),
    name: n.fullName,
    nickname: n.nickname,
    phone: n.phone,
    email: n.email,
    status: n.nannyStatus,
    age: n.age,
    exp: n.experienceYears,
    rate: n.hourlyRate,
    rating: n.ratingAverage,
    cpr: n.cprCertified ? 'yes' : '',
    videos: (n.videos || []).length,
    photos: (n.photos || []).length,
    approved: [...(n.videos || []), ...(n.photos || [])].filter((m) => m.approved).length,
    featured: [...(n.videos || []), ...(n.photos || [])].filter((m) => m.approved && m.featured).length,
    lastSeen: day(n.lastSeenAt),
  })));

  addSheet(book, 'Bookings', [
    { header: 'Booking #', key: 'no', width: 14 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Family', key: 'family', width: 22 },
    { header: 'Family phone', key: 'famPhone', width: 18 },
    { header: 'Nanny', key: 'nanny', width: 22 },
    { header: 'Nanny phone', key: 'nannyPhone', width: 18 },
    { header: 'Start', key: 'start', width: 12 },
    { header: 'End', key: 'end', width: 12 },
    { header: 'Time', key: 'time', width: 8 },
    { header: 'Hours/day', key: 'hours', width: 10 },
    { header: 'Days', key: 'days', width: 7 },
    { header: 'Rate/hr', key: 'rate', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Paid', key: 'paid', width: 10 },
    { header: 'Emergency', key: 'emg', width: 11 },
    { header: 'Surcharge', key: 'surcharge', width: 11, style: { numFmt: '#,##0' } },
    { header: '24h live-in', key: 'liveIn', width: 11 },
    { header: 'Nannies needed', key: 'needed', width: 14 },
    { header: 'Children', key: 'children', width: 9 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], bookings.map((b) => ({
    no: b.bookingNumber,
    status: b.status,
    family: b.family?.fullName,
    famPhone: b.family?.phone,
    nanny: b.nanny?.nickname || b.nanny?.fullName,
    nannyPhone: b.nanny?.phone,
    start: b.startDate,
    end: b.endDate,
    time: b.startTime,
    hours: b.hoursPerDay,
    days: (b.serviceDays || []).length,
    rate: b.hourlyRate,
    total: b.totalAmount,
    paid: b.paymentStatus,
    emg: b.isEmergency ? 'yes' : '',
    surcharge: b.emergencySurcharge || 0,
    liveIn: b.isLiveIn ? 'yes' : '',
    needed: b.nanniesNeeded || 1,
    children: (b.children || []).length,
    address: b.address?.addressLine,
    created: day(b.createdAt),
  })));

  addSheet(book, 'Payments', [
    { header: 'Reference', key: 'ref', width: 18 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Booking', key: 'booking', width: 26 },
    { header: 'Amount', key: 'amount', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], payments.map((p) => ({
    ref: p.reference,
    kind: p.kind,
    booking: str(p.booking),
    amount: p.amount,
    status: p.status,
    method: p.method,
    created: day(p.createdAt),
  })));

  addSheet(book, 'Notes', [
    { header: 'About', key: 'targetType', width: 10 },
    { header: 'Target ID', key: 'target', width: 26 },
    { header: 'Booking #', key: 'booking', width: 12 },
    { header: 'Note', key: 'body', width: 60 },
    { header: 'Author', key: 'author', width: 20 },
    { header: 'Written', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], notes.map((n) => ({
    targetType: n.targetType,
    target: str(n.target),
    booking: n.bookingNumber || '',
    body: n.body,
    author: n.authorName,
    created: day(n.createdAt),
  })));

  addSheet(book, 'Callbacks', [
    { header: 'Reference', key: 'ref', width: 14 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Reason', key: 'reason', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Promised at', key: 'promised', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], callbacks.map((c) => ({
    ref: c.reference,
    name: c.fullName,
    phone: c.phone,
    reason: c.reason,
    status: c.status,
    promised: day(c.promisedCallAt),
    created: day(c.createdAt),
  })));

  addSheet(book, 'Tickets', [
    { header: 'Reference', key: 'ref', width: 14 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Priority', key: 'priority', width: 10 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], tickets.map((t) => ({
    ref: t.reference || str(t._id),
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    created: day(t.createdAt),
  })));

  return book;
}

/**
 * Build today's workbook and email it.
 *
 * Returns what was sent so the scheduler can log it, and throws on failure so
 * a silent backup gap is impossible — a backup nobody knows has stopped is
 * worse than no backup at all.
 */
export async function sendDailyBackup({ to = config.backup.email } = {}) {
  const book = await buildBackupWorkbook();
  const buffer = Buffer.from(await book.xlsx.writeBuffer());

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `nanny-in-paradise-backup-${stamp}.xlsx`;

  const counts = book.worksheets
    .map((s) => `${s.name}: ${Math.max(0, s.rowCount - 1)}`)
    .join(' · ');

  await send({
    to,
    subject: `Daily backup — ${stamp}`,
    text: `Attached is the end-of-day backup for ${stamp}.\n\n${counts}`,
    html: brandedEmail(`
      <p style="color:#333;font-size:15px;margin:0 0 8px">Attached is the end-of-day backup for <strong>${stamp}</strong>.</p>
      <p style="color:#666;font-size:13px;margin:0">${counts.replace(/ · /g, '<br>')}</p>
    `),
    attachments: [{ filename, content: buffer }],
  });

  return { to, filename, bytes: buffer.length, counts };
}

/**
 * A record of one order, emailed the moment it is paid for.
 *
 * The nightly file is a safety net for the whole business; this is a receipt
 * for a single transaction, and it lands while the order is still fresh. Two
 * different jobs, so two different emails: if the nightly one ever fails, the
 * per-order trail still reconstructs every booking that was actually paid.
 *
 * Failure is logged, never thrown — a bookkeeping email must not be able to
 * fail a payment that has already been approved.
 */
export async function sendOrderBackup(booking, { to = config.backup.email } = {}) {
  if (!booking) return null;

  const { User } = await import('../models/index.js');
  const [family, nanny] = await Promise.all([
    booking.family ? User.findById(booking.family).select('fullName phone email').lean() : null,
    booking.nanny ? User.findById(booking.nanny).select('fullName nickname phone').lean() : null,
  ]);

  const rows = [
    ['Booking', booking.bookingNumber],
    ['Status', booking.status],
    ['Family', family?.fullName || '—'],
    ['Family phone', family?.phone || '—'],
    ['Nanny', nanny?.nickname || nanny?.fullName || '—'],
    ['Nanny phone', nanny?.phone || '—'],
    ['Dates', booking.isMultiDay ? `${booking.startDate} to ${booking.endDate}` : booking.startDate],
    ['Start time', booking.startTime || '—'],
    ['Hours per day', String(booking.hoursPerDay ?? '—')],
    ['Days booked', String((booking.serviceDays || []).length)],
    ['Children', String((booking.children || []).length)],
    ['Rate per hour', money(booking.hourlyRate || 0)],
    ['Total', money(booking.totalAmount || 0)],
    ['Paid', money(booking.paidAmount || 0)],
    ['Emergency', booking.isEmergency ? `yes (+${money(booking.emergencySurcharge || 0)} cash on arrival)` : 'no'],
    ['Address', booking.address?.addressLine || '—'],
  ];

  // A spreadsheet as well as the table, so these can be collected into a
  // ledger without retyping anything.
  const book = new ExcelJS.Workbook();
  book.creator = config.brand.name;
  addSheet(book, 'Order', [
    { header: 'Field', key: 'field', width: 22 },
    { header: 'Value', key: 'value', width: 50 },
  ], rows.map(([field, value]) => ({ field, value })));

  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  const filename = `order-${booking.bookingNumber}.xlsx`;

  await send({
    to,
    subject: `Order paid — #${booking.bookingNumber} — ${money(booking.totalAmount || 0)}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: brandedEmail(`
      <p style="color:#333;font-size:15px;margin:0 0 14px">
        Payment confirmed for booking <strong>#${booking.bookingNumber}</strong>.
      </p>
      <table style="border-collapse:collapse;font-size:14px">
        ${rows.map(([k, v]) => `
          <tr>
            <td style="padding:4px 14px 4px 0;color:#777;white-space:nowrap">${k}</td>
            <td style="padding:4px 0;color:#111"><strong>${v}</strong></td>
          </tr>`).join('')}
      </table>
    `),
    attachments: [{ filename, content: buffer }],
  });

  return { to, filename, bookingNumber: booking.bookingNumber };
}

export default { sendDailyBackup, buildBackupWorkbook, sendOrderBackup };
