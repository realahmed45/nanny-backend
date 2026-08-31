import express from 'express';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import {
  User, Booking, Ticket, ChatThread, MessageLog, AdminUser, Session,
} from '../models/index.js';
import { Payment, Payout } from '../models/Payment.js';
import {
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, PAYMENT_STATUS, PAYOUT_STATUS,
  TICKET_STATUS, CANCELLED_BY, SERVICE_DAY_STATUS, BOOKING_SUBSTATUS,
} from '../utils/constants.js';
import { signToken, requireAuth, requireRole } from '../middleware/auth.js';
import { cancelBooking, markNannyCancelled, openNannyResponseWindow } from '../services/booking.js';
import {
  refundBooking, releaseDuePayouts, queuePayout,
  approveTransfer, rejectTransfer, completeRefund, markPayoutPaid,
} from '../services/payments.js';
import { computeCancellationRefund } from '../services/policy.js';
import { notifyUser, notifyPhone } from '../services/notify.js';
import { money } from '../utils/format.js';
import * as M from '../utils/messages.js';
import config from '../config/index.js';

const router = express.Router();

/** Wrap an async handler so rejections become 500s instead of hangs. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const admin = await AdminUser.findOne({ email: String(email).toLowerCase() });
  if (!admin || !admin.active) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  admin.lastLoginAt = new Date();
  await admin.save();

  res.json({
    token: signToken(admin),
    admin: { id: admin._id, email: admin.email, name: admin.name, role: admin.role },
  });
}));

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    admin: {
      id: req.admin._id, email: req.admin.email,
      name: req.admin.name, role: req.admin.role,
    },
  });
});

// Everything below requires an authenticated admin.
router.use(requireAuth);

/* ------------------------------------------------------------------ *
 * Dashboard overview
 * ------------------------------------------------------------------ */

router.get('/dashboard/stats', wrap(async (req, res) => {
  const now = new Date();
  const weekStart = dayjs(now).startOf('week').toDate();
  const monthStart = dayjs(now).startOf('month').toDate();

  const [
    totalFamilies, totalNannies, pendingNannies, verifiedNannies,
    activeBookings, upcomingBookings, completedBookings, cancelledBookings,
    openTickets,
  ] = await Promise.all([
    User.countDocuments({ role: USER_ROLE.FAMILY }),
    User.countDocuments({ role: USER_ROLE.NANNY }),
    User.countDocuments({ role: USER_ROLE.NANNY, nannyStatus: NANNY_STATUS.PENDING_VERIFICATION }),
    User.countDocuments({ role: USER_ROLE.NANNY, nannyStatus: NANNY_STATUS.VERIFIED }),
    Booking.countDocuments({ status: BOOKING_STATUS.ONGOING }),
    Booking.countDocuments({ status: BOOKING_STATUS.UPCOMING }),
    Booking.countDocuments({ status: BOOKING_STATUS.COMPLETED }),
    Booking.countDocuments({ status: BOOKING_STATUS.CANCELLED }),
    Ticket.countDocuments({ status: { $in: [TICKET_STATUS.OPEN, TICKET_STATUS.IN_PROGRESS] } }),
  ]);

  const [revenueAgg, weekRevenueAgg, monthRevenueAgg, refundAgg] = await Promise.all([
    sumPayments({ status: PAYMENT_STATUS.COMPLETED, kind: { $ne: 'refund' } }),
    sumPayments({ status: PAYMENT_STATUS.COMPLETED, kind: { $ne: 'refund' }, createdAt: { $gte: weekStart } }),
    sumPayments({ status: PAYMENT_STATUS.COMPLETED, kind: { $ne: 'refund' }, createdAt: { $gte: monthStart } }),
    sumPayments({ kind: 'refund', status: PAYMENT_STATUS.REFUNDED }),
  ]);

  // Booking trend for the last 14 days.
  const trend = await Booking.aggregate([
    { $match: { createdAt: { $gte: dayjs(now).subtract(13, 'day').startOf('day').toDate() } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, revenue: { $sum: '$totalAmount' } } },
    { $sort: { _id: 1 } },
  ]);

  // Extra counts the dashboard cards and the Action Required feed need.
  const [
    suspendedFamilies, replacementNeeded, pendingRequests,
    paymentsPending, refundsInProcess, criticalTickets, nextUpcoming,
  ] = await Promise.all([
    User.countDocuments({ role: USER_ROLE.FAMILY, blocked: true }),
    Booking.countDocuments({ subStatus: BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT }),
    Booking.countDocuments({
      'nannyResponses.outcome': 'pending',
      status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
    }),
    Payment.countDocuments({ status: PAYMENT_STATUS.IN_PROCESS }),
    Payment.countDocuments({ status: PAYMENT_STATUS.REFUND_IN_PROCESS }),
    Ticket.countDocuments({
      status: { $in: [TICKET_STATUS.OPEN, TICKET_STATUS.IN_PROGRESS] },
      priority: { $in: ['urgent', 'high'] },
    }),
    Booking.findOne({ status: BOOKING_STATUS.UPCOMING }).sort({ startDate: 1 }).select('startDate'),
  ]);

  const [pendingAmountAgg, refundAmountAgg] = await Promise.all([
    sumPayments({ status: PAYMENT_STATUS.IN_PROCESS }),
    sumPayments({ status: PAYMENT_STATUS.REFUND_IN_PROCESS }),
  ]);

  // An ongoing booking is "OTP pending" when today's service day is still
  // waiting on either the arrival or the end-of-service code.
  const otpPending = await Booking.countDocuments({
    status: BOOKING_STATUS.ONGOING,
    'serviceDays.status': {
      $in: [SERVICE_DAY_STATUS.AWAITING_ARRIVAL, SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE],
    },
  });

  res.json({
    users: {
      families: totalFamilies, nannies: totalNannies,
      pendingNannies, verifiedNannies, suspendedFamilies,
    },
    bookings: {
      active: activeBookings, upcoming: upcomingBookings,
      completed: completedBookings, cancelled: cancelledBookings,
      replacementNeeded, pendingRequests, otpPending,
      nextUpcomingDate: nextUpcoming?.startDate || null,
      total: activeBookings + upcomingBookings + completedBookings + cancelledBookings,
    },
    revenue: {
      total: revenueAgg, thisWeek: weekRevenueAgg,
      thisMonth: monthRevenueAgg, refunded: refundAgg,
      pendingCount: paymentsPending, pendingAmount: pendingAmountAgg,
      refundsInProcess: refundsInProcess, refundsAmount: refundAmountAgg,
    },
    support: { openTickets, criticalTickets },
    trend,
  });
}));

/* ------------------------------------------------------------------ *
 * Action Required feed — the prioritised work queue on the dashboard.
 * ------------------------------------------------------------------ */

router.get('/dashboard/actions', wrap(async (req, res) => {
  const items = [];

  const [charged, expiring, otpBookings, replacements, pendingNannies, openTickets] =
    await Promise.all([
      Payment.find({ status: PAYMENT_STATUS.REFUND_IN_PROCESS })
        .populate({ path: 'booking', select: 'bookingNumber family',
                    populate: { path: 'family', select: 'fullName' } })
        .limit(5),
      Booking.find({
        'nannyResponses.outcome': 'pending',
        status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
      }).populate('nanny', 'fullName').limit(5),
      Booking.find({
        status: BOOKING_STATUS.ONGOING,
        'serviceDays.status': {
          $in: [SERVICE_DAY_STATUS.AWAITING_ARRIVAL, SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE],
        },
      }).limit(5),
      Booking.find({ subStatus: BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT })
        .populate('family', 'fullName').limit(5),
      User.find({ role: USER_ROLE.NANNY, nannyStatus: NANNY_STATUS.PENDING_VERIFICATION })
        .select('fullName').limit(5),
      Ticket.find({ status: { $in: [TICKET_STATUS.OPEN, TICKET_STATUS.IN_PROGRESS] } })
        .sort({ createdAt: 1 }).limit(5),
    ]);

  if (charged.length) {
    items.push({
      severity: 'critical', title: 'Charged booking cancelled — refund needed',
      subtitle: charged
        .map((p) => `${p.booking?.family?.fullName || 'Family'} · #${p.booking?.bookingNumber || '—'}`)
        .join(', '),
      count: charged.length, action: 'View', link: '/bookings',
    });
  }
  if (expiring.length) {
    const soonest = expiring
      .flatMap((b) => b.nannyResponses.filter((r) => r.outcome === 'pending'))
      .map((r) => new Date(r.expiresAt))
      .sort((a, b) => a - b)[0];
    const mins = soonest ? Math.max(0, Math.round((soonest - Date.now()) / 60000)) : null;
    items.push({
      severity: 'high', title: 'Booking requests expiring soon',
      subtitle: mins !== null ? `${mins} min remaining` : 'awaiting nanny response',
      count: expiring.length, action: 'View', link: '/bookings',
    });
  }
  if (otpBookings.length) {
    items.push({
      severity: 'high', title: 'OTP confirmation pending on active booking',
      subtitle: otpBookings.map((b) => `#${b.bookingNumber}`).join(', '),
      count: otpBookings.length, action: 'View', link: '/bookings',
    });
  }
  if (replacements.length) {
    items.push({
      severity: 'high', title: 'Replacement nanny needed',
      subtitle: replacements.map((b) => `#${b.bookingNumber} · ${b.family?.fullName || 'Family'}`).join(', '),
      count: replacements.length, action: 'Assign', link: '/bookings',
    });
  }
  if (pendingNannies.length) {
    items.push({
      severity: 'medium', title: 'Nanny verification pending review',
      subtitle: pendingNannies.map((n) => n.fullName).join(', '),
      count: pendingNannies.length, action: 'Review', link: '/nannies',
    });
  }
  if (openTickets.length) {
    items.push({
      severity: 'low', title: 'Open support tickets',
      subtitle: `Oldest: ${dayjs(openTickets[0].createdAt).format('D MMM')}`,
      count: openTickets.length, action: 'View', link: '/support',
    });
  }

  res.json({ items });
}));

async function sumPayments(match) {
  const [row] = await Payment.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total || 0;
}

/* ------------------------------------------------------------------ *
 * Calendar — every booking day, plus nanny blocked dates, for a month.
 * ------------------------------------------------------------------ */

router.get('/calendar', wrap(async (req, res) => {
  const month = req.query.month || dayjs().format('YYYY-MM');
  const start = dayjs(`${month}-01`).startOf('month');
  const end = start.endOf('month');

  const bookings = await Booking.find({
    status: { $ne: BOOKING_STATUS.DRAFT },
    startDate: { $lte: end.format('YYYY-MM-DD') },
    $or: [
      { endDate: { $gte: start.format('YYYY-MM-DD') } },
      { endDate: null, startDate: { $gte: start.format('YYYY-MM-DD') } },
    ],
  })
    .populate('family', 'fullName')
    .populate('nanny', 'fullName');

  // One event per service day so multi-day bookings appear on each date.
  const events = [];
  for (const b of bookings) {
    const family = b.family?.fullName?.split(' ')[0] || 'Family';
    const familyLast = b.family?.fullName?.split(' ').slice(-1)[0] || '';
    const nanny = b.nanny?.fullName?.split(' ')[0] || null;
    const label = b.subStatus === BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT
      ? `${family[0]}. ${familyLast} — Replacement Needed`
      : b.status === BOOKING_STATUS.CANCELLED
        ? `${family[0]}. ${familyLast} — Cancelled`
        : `${family[0]}. ${familyLast}${nanny ? ` + ${nanny}` : ''}`;

    const status = b.subStatus === BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT
      ? 'replacement_needed' : b.status;

    const days = b.serviceDays?.length
      ? b.serviceDays.map((d) => dayjs(d.startAt).format('YYYY-MM-DD'))
      : [b.startDate];

    for (const date of days) {
      if (date < start.format('YYYY-MM-DD') || date > end.format('YYYY-MM-DD')) continue;
      events.push({
        date, label, status, bookingId: String(b._id), bookingNumber: b.bookingNumber,
        family: b.family?.fullName, nanny: b.nanny?.fullName,
      });
    }
  }

  // Nanny blocked dates within the month.
  const nannies = await User.find({
    role: USER_ROLE.NANNY, 'availability.blockedDates': { $exists: true, $ne: [] },
  }).select('fullName availability.blockedDates');

  for (const n of nannies) {
    for (const date of n.availability?.blockedDates || []) {
      if (date < start.format('YYYY-MM-DD') || date > end.format('YYYY-MM-DD')) continue;
      events.push({ date, label: `${n.fullName} — Blocked`, status: 'blocked', nanny: n.fullName });
    }
  }

  res.json({ month, events });
}));

/* ------------------------------------------------------------------ *
 * Referrals — who invited whom, and how far they got.
 * ------------------------------------------------------------------ */

router.get('/referrals', wrap(async (req, res) => {
  const referred = await User.find({ referredBy: { $ne: null } })
    .populate('referredBy', 'fullName role referralCode')
    .sort({ createdAt: -1 })
    .limit(200);

  const rows = await Promise.all(referred.map(async (u) => {
    const bookings = await Booking.countDocuments({
      [u.role === USER_ROLE.NANNY ? 'nanny' : 'family']: u._id,
      status: { $ne: BOOKING_STATUS.DRAFT },
    });
    const verified = u.role === USER_ROLE.NANNY
      ? u.nannyStatus === NANNY_STATUS.VERIFIED
      : Boolean(u.emailVerified);

    return {
      _id: String(u._id),
      referrer: u.referredBy?.fullName || '—',
      referrerRole: u.referredBy?.role || null,
      referrerCode: u.referredBy?.referralCode || null,
      contact: u.fullName,
      email: u.email || null,
      phone: u.phone,
      dateReferred: u.createdAt,
      joined: true,
      userType: u.role,
      verified,
      firstBooking: bookings > 0,
      status: bookings > 0 ? 'successful' : verified ? 'pending' : 'invited',
    };
  }));

  const successful = rows.filter((r) => r.status === 'successful').length;
  const pending = rows.filter((r) => r.status === 'pending').length;

  res.json({
    rows,
    summary: {
      total: rows.length,
      successful,
      pending,
      successRate: rows.length ? Math.round((successful / rows.length) * 100) : 0,
    },
  });
}));

/* ------------------------------------------------------------------ *
 * Nannies
 * ------------------------------------------------------------------ */

router.get('/nannies', wrap(async (req, res) => {
  const { status, search, page = 1, limit = 25 } = req.query;
  const query = { role: USER_ROLE.NANNY };
  if (status) query.nannyStatus = status;
  if (search) {
    query.$or = [
      { fullName: new RegExp(escapeRe(search), 'i') },
      { email: new RegExp(escapeRe(search), 'i') },
      { phone: new RegExp(escapeRe(search), 'i') },
    ];
  }
  const result = await paginate(User, query, req.query, { sort: { createdAt: -1 } });

  // The listing shows live booking counts and a derived availability state,
  // so enrich each row rather than making the table fetch per nanny.
  result.items = await Promise.all(result.items.map(async (n) => {
    const [active, total] = await Promise.all([
      Booking.countDocuments({
        nanny: n._id, status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
      }),
      Booking.countDocuments({ nanny: n._id, status: { $ne: BOOKING_STATUS.DRAFT } }),
    ]);

    // Availability reflects the calendar only; approval is shown separately.
    const today = dayjs().format('YYYY-MM-DD');
    const blocked = (n.availability?.blockedDates || []).includes(today);
    const suspended = n.blocked || n.nannyStatus === NANNY_STATUS.SUSPENDED
      || n.nannyStatus === NANNY_STATUS.REJECTED;
    const availability = suspended || blocked
      ? 'unavailable'
      : active > 0 ? 'partially_booked' : 'available';

    return { ...n.toObject(), activeBookings: active, totalBookings: total, availability };
  }));

  res.json(result);
}));

router.get('/nannies/:id', wrap(async (req, res) => {
  const nanny = await User.findOne({ _id: req.params.id, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(404).json({ error: 'Nanny not found' });

  const [bookings, payouts, rating] = await Promise.all([
    Booking.find({ nanny: nanny._id }).sort({ createdAt: -1 }).limit(20),
    Payout.find({ nanny: nanny._id }).sort({ createdAt: -1 }).limit(20),
    Booking.aggregate([
      { $match: { nanny: nanny._id, 'rating.stars': { $exists: true } } },
      { $group: { _id: null, avg: { $avg: '$rating.stars' }, count: { $sum: 1 } } },
    ]),
  ]);

  res.json({ nanny, bookings, payouts, rating: rating[0] || { avg: 0, count: 0 } });
}));

/** Approve a nanny and let her know over WhatsApp. */
router.post('/nannies/:id/verify', wrap(async (req, res) => {
  const nanny = await User.findOne({ _id: req.params.id, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(404).json({ error: 'Nanny not found' });

  nanny.nannyStatus = NANNY_STATUS.VERIFIED;
  nanny.backgroundCheckPassed = req.body?.backgroundCheckPassed ?? true;
  nanny.rejectionReason = undefined;
  nanny.documents = (nanny.documents || []).map((d) => ({ ...d.toObject(), verified: true }));
  await nanny.save();

  // Drop her straight onto the main menu so the reply lands somewhere useful.
  const session = await Session.findOne({ phone: nanny.phone });
  if (session) {
    session.state = 'NANNY_MAIN_MENU';
    session.data = {};
    session.stack = [];
    await session.save();
  }
  await notifyUser(nanny, `${M.NANNY_VERIFIED}\n\n${M.NANNY_MAIN_MENU}`);

  res.json({ ok: true, nanny });
}));

router.post('/nannies/:id/reject', wrap(async (req, res) => {
  const nanny = await User.findOne({ _id: req.params.id, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(404).json({ error: 'Nanny not found' });

  nanny.nannyStatus = NANNY_STATUS.REJECTED;
  nanny.rejectionReason = req.body?.reason || 'Documents could not be verified.';
  await nanny.save();

  await notifyUser(nanny, M.NANNY_REJECTED(nanny.rejectionReason));
  res.json({ ok: true, nanny });
}));

router.post('/nannies/:id/suspend', wrap(async (req, res) => {
  const nanny = await User.findOne({ _id: req.params.id, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(404).json({ error: 'Nanny not found' });

  nanny.nannyStatus = NANNY_STATUS.SUSPENDED;
  nanny.blocked = true;
  nanny.rejectionReason = req.body?.reason;
  await nanny.save();

  await notifyUser(nanny, `⚠️ Your account has been suspended.\n\n${req.body?.reason || 'Please contact support for details.'}`);
  res.json({ ok: true, nanny });
}));

/** Spec: "Delete pending Nanny" card on the payments screen. */
router.delete('/nannies/:id', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const nanny = await User.findOne({ _id: req.params.id, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(404).json({ error: 'Nanny not found' });

  const live = await Booking.countDocuments({
    nanny: nanny._id,
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
  });
  if (live > 0) {
    return res.status(409).json({ error: `This nanny has ${live} active booking(s). Reassign or cancel them first.` });
  }

  await Session.deleteOne({ phone: nanny.phone });
  await User.deleteOne({ _id: nanny._id });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Families
 * ------------------------------------------------------------------ */

router.get('/families', wrap(async (req, res) => {
  const { search } = req.query;
  const query = { role: USER_ROLE.FAMILY };
  if (search) {
    query.$or = [
      { fullName: new RegExp(escapeRe(search), 'i') },
      { email: new RegExp(escapeRe(search), 'i') },
      { phone: new RegExp(escapeRe(search), 'i') },
    ];
  }
  const result = await paginate(User, query, req.query, { sort: { createdAt: -1 } });

  // Per-family booking/spend/ticket counters shown in the listing.
  result.items = await Promise.all(result.items.map(async (f) => {
    const [total, active, completed, cancelled, tickets, spentAgg] = await Promise.all([
      Booking.countDocuments({ family: f._id, status: { $ne: BOOKING_STATUS.DRAFT } }),
      Booking.countDocuments({
        family: f._id, status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
      }),
      Booking.countDocuments({ family: f._id, status: BOOKING_STATUS.COMPLETED }),
      Booking.countDocuments({ family: f._id, status: BOOKING_STATUS.CANCELLED }),
      Ticket.countDocuments({
        raisedBy: f._id, status: { $in: [TICKET_STATUS.OPEN, TICKET_STATUS.IN_PROGRESS] },
      }),
      Payment.aggregate([
        { $match: { family: f._id, status: PAYMENT_STATUS.COMPLETED, kind: { $ne: 'refund' } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    return {
      ...f.toObject(),
      stats: {
        total, active, completed, cancelled, tickets,
        spent: spentAgg[0]?.total || 0,
      },
    };
  }));

  res.json(result);
}));

router.get('/families/:id', wrap(async (req, res) => {
  const family = await User.findOne({ _id: req.params.id, role: USER_ROLE.FAMILY });
  if (!family) return res.status(404).json({ error: 'Family not found' });

  const [bookings, payments] = await Promise.all([
    Booking.find({ family: family._id }).populate('nanny', 'fullName').sort({ createdAt: -1 }).limit(20),
    Payment.find({ family: family._id }).sort({ createdAt: -1 }).limit(20),
  ]);
  res.json({ family, bookings, payments });
}));

router.post('/families/:id/verify-id', wrap(async (req, res) => {
  const family = await User.findOne({ _id: req.params.id, role: USER_ROLE.FAMILY });
  if (!family) return res.status(404).json({ error: 'Family not found' });
  family.idVerified = req.body?.verified !== false;
  await family.save();
  res.json({ ok: true, family });
}));

router.post('/families/:id/block', wrap(async (req, res) => {
  const family = await User.findOne({ _id: req.params.id, role: USER_ROLE.FAMILY });
  if (!family) return res.status(404).json({ error: 'Family not found' });
  family.blocked = req.body?.blocked !== false;
  await family.save();
  res.json({ ok: true, family });
}));

/* ------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------ */

router.get('/bookings', wrap(async (req, res) => {
  const { status, search, from, to } = req.query;
  const query = {};
  if (status) query.status = status;
  if (from || to) {
    query.startDate = {};
    if (from) query.startDate.$gte = from;
    if (to) query.startDate.$lte = to;
  }
  if (search) query.bookingNumber = new RegExp(escapeRe(search), 'i');

  res.json(await paginate(Booking, query, req.query, {
    sort: { createdAt: -1 },
    populate: [{ path: 'family', select: 'fullName phone email' }, { path: 'nanny', select: 'fullName phone' }],
  }));
}));

router.get('/bookings/:id', wrap(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('family', 'fullName phone email children')
    .populate('nanny', 'fullName phone hourlyRate ratingAverage');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const [payments, payouts, thread] = await Promise.all([
    Payment.find({ booking: booking._id }).sort({ createdAt: -1 }),
    Payout.find({ booking: booking._id }).sort({ createdAt: -1 }),
    ChatThread.findOne({ booking: booking._id }),
  ]);
  res.json({ booking, payments, payouts, chat: thread });
}));

/** Preview what a cancellation would refund, without performing it. */
router.get('/bookings/:id/refund-preview', wrap(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const cancelledBy = req.query.cancelledBy || CANCELLED_BY.ADMIN;
  res.json(computeCancellationRefund(booking, { cancelledBy }));
}));

router.post('/bookings/:id/cancel', wrap(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    return res.status(409).json({ error: 'Booking is already cancelled' });
  }

  const nannyId = booking.nanny;
  const breakdown = await cancelBooking(booking, {
    cancelledBy: CANCELLED_BY.ADMIN,
    reason: req.body?.reason || 'Cancelled by admin',
  });

  if (breakdown.totalRefund > 0) {
    await refundBooking(booking, { amount: breakdown.totalRefund, breakdown, reason: 'Admin cancellation' });
  }
  if (breakdown.completedAmount > 0 && nannyId) {
    await queuePayout(booking, {
      nannyId, amount: breakdown.completedAmount, isFinal: true,
      notes: 'Completed services before admin cancellation',
    });
  }

  const family = await User.findById(booking.family);
  await notifyUser(family, `🔴 *Booking Cancelled by My Nanny*

Booking #${booking.bookingNumber} has been cancelled.
${req.body?.reason ? `\nReason: ${req.body.reason}` : ''}

💰 A full refund of *$${breakdown.totalRefund}* for all unused services is being processed.`);

  if (nannyId) {
    const nanny = await User.findById(nannyId);
    await notifyUser(nanny, `🔴 Booking #${booking.bookingNumber} has been cancelled by My Nanny.`);
  }

  res.json({ ok: true, booking, breakdown });
}));

/** Admin reassigns a booking to a different nanny. */
router.post('/bookings/:id/assign-nanny', wrap(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const nanny = await User.findOne({ _id: req.body?.nannyId, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(404).json({ error: 'Nanny not found' });
  if (nanny.nannyStatus !== NANNY_STATUS.VERIFIED) {
    return res.status(409).json({ error: 'Nanny is not verified' });
  }

  const { assignReplacement, openNannyResponseWindow } = await import('../services/booking.js');
  const { difference, requiresPayment } = await assignReplacement(booking, nanny);

  const family = await User.findById(booking.family);
  if (!requiresPayment) {
    booking.status = BOOKING_STATUS.UPCOMING;
    const { expiresAt } = openNannyResponseWindow(booking, nanny._id, 'new_booking');
    await booking.save();
    await notifyUser(nanny, M.nannyBookingRequest(booking, family, expiresAt));
    const { setNannyRequestState } = await import('../flows/familyBookingPayment.js');
    await setNannyRequestState(nanny, booking);
  }

  await notifyUser(family, `👩 *Nanny Assigned*

${nanny.fullName} has been assigned to Booking #${booking.bookingNumber}.${requiresPayment ? `\n\n💰 An additional payment of $${difference} is required. Open *My Bookings* to pay.` : ''}`);

  res.json({ ok: true, booking, difference, requiresPayment });
}));

/* ------------------------------------------------------------------ *
 * Payments & payouts
 * ------------------------------------------------------------------ */

router.get('/payments', wrap(async (req, res) => {
  const { status, kind } = req.query;
  const query = {};
  if (status) query.status = status;
  if (kind) query.kind = kind;
  res.json(await paginate(Payment, query, req.query, {
    sort: { createdAt: -1 },
    populate: [
      { path: 'family', select: 'fullName phone' },
      { path: 'booking', select: 'bookingNumber nanny', populate: { path: 'nanny', select: 'fullName' } },
    ],
  }));
}));

router.get('/payouts', wrap(async (req, res) => {
  const { status } = req.query;
  const query = {};
  if (status) query.status = status;
  res.json(await paginate(Payout, query, req.query, {
    sort: { createdAt: -1 },
    populate: [{ path: 'nanny', select: 'fullName phone' }, { path: 'booking', select: 'bookingNumber' }],
  }));
}));

/**
 * Payment summary cards.
 * Spec (8/11 discussion): family payments allocated this week, nanny payments
 * allocated this week, and the count of pending nannies awaiting deletion.
 */
router.get('/payments/summary', wrap(async (req, res) => {
  const weekStart = dayjs().startOf('week').toDate();
  const weekEnd = dayjs().endOf('week').toDate();

  // Payouts are released on Mondays, so "next Monday" is the upcoming release.
  const nextMonday = dayjs().day() === 1 && dayjs().hour() < 9
    ? dayjs().startOf('day')
    : dayjs().add(1, 'week').startOf('week').add(1, 'day');

  const [familyWeek, nannyWeek, nextRelease, refunds, awaiting] = await Promise.all([
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.COMPLETED, kind: { $ne: 'refund' }, createdAt: { $gte: weekStart, $lte: weekEnd } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payout.aggregate([
      { $match: { scheduledFor: { $gte: weekStart, $lte: weekEnd } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payout.aggregate([
      { $match: { status: PAYOUT_STATUS.PENDING, scheduledFor: { $lte: nextMonday.endOf('day').toDate() } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.REFUND_IN_PROCESS } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.IN_PROCESS, kind: { $ne: 'refund' } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    familyPaymentsThisWeek: { total: familyWeek[0]?.total || 0, count: familyWeek[0]?.count || 0 },
    nannyPaymentsThisWeek: { total: nannyWeek[0]?.total || 0, count: nannyWeek[0]?.count || 0 },
    nextMondayRelease: {
      total: nextRelease[0]?.total || 0,
      count: nextRelease[0]?.count || 0,
      date: nextMonday.format('YYYY-MM-DD'),
    },
    refundsInProcess: { total: refunds[0]?.total || 0, count: refunds[0]?.count || 0 },
    awaitingReview: { total: awaiting[0]?.total || 0, count: awaiting[0]?.count || 0 },
  });
}));

/** Manually release all payouts that are due (normally the Monday job). */
router.post('/payouts/release', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const released = await releaseDuePayouts(new Date());
  res.json({ ok: true, released: released.length, payouts: released });
}));

router.post('/payouts/:id/release', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  payout.scheduledFor = new Date();
  await payout.save();
  const released = await releaseDuePayouts(new Date());
  res.json({ ok: true, released: released.length });
}));

/**
 * Approve a family's transfer. This is the only path that marks a booking
 * paid, and it is what releases the request to the nanny — so the nanny is
 * never asked to hold a slot for money that has not arrived.
 */
router.post('/payments/:id/approve', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.kind === 'refund') {
    return res.status(400).json({ error: 'Use /complete-refund for refunds' });
  }

  const { booking } = await approveTransfer(payment, {
    adminId: req.admin?.id,
    note: req.body?.note || '',
  });

  if (booking) {
    const [family, nanny] = await Promise.all([
      User.findById(booking.family),
      booking.nanny ? User.findById(booking.nanny) : null,
    ]);

    if (family) await notifyUser(family, M.PAYMENT_VERIFIED);

    // Open the nanny's response window now that the money is confirmed.
    if (nanny && booking.status === BOOKING_STATUS.PENDING_PAYMENT) {
      const { expiresAt } = openNannyResponseWindow(booking, nanny._id, 'new_booking');
      booking.status = BOOKING_STATUS.UPCOMING;
      await booking.save();

      await notifyUser(nanny, M.nannyBookingRequest(booking, family, expiresAt));
      const { setNannyRequestState } = await import('../flows/familyBookingPayment.js');
      await setNannyRequestState(nanny, booking);
    }
  }

  res.json({ ok: true, payment, booking });
}));

/** Reject a transfer — the family is told why and can send a new screenshot. */
router.post('/payments/:id/reject', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  const note = req.body?.note || '';
  const { booking } = await rejectTransfer(payment, { adminId: req.admin?.id, note });

  const family = await User.findById(payment.family);
  if (family) {
    await notifyUser(family, M.paymentRejected(note));
    const session = await Session.findOne({ phone: family.phone });
    if (session) {
      session.state = 'FF_PAYMENT_REJECTED';
      session.data = { ...(session.data || {}), payingBookingId: String(payment.booking) };
      session.markModified('data');
      await session.save();
    }
  }

  res.json({ ok: true, payment, booking });
}));

/** Record a refund owed to a family (admin transfers it manually afterwards). */
router.post('/payments/:id/refund', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  const booking = await Booking.findById(payment.booking);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const amount = Number(req.body?.amount ?? payment.amount);
  const result = await refundBooking(booking, {
    amount,
    reason: req.body?.reason || 'Manual admin refund',
  });
  res.json({ ok: result.success, refund: result.payment });
}));

/** Mark a refund as sent, with the transfer receipt attached. */
router.post('/payments/:id/complete-refund', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.kind !== 'refund') {
    return res.status(400).json({ error: 'That payment is not a refund' });
  }

  const { booking } = await completeRefund(payment, {
    adminId: req.admin?.id,
    proof: { url: req.body?.proofUrl, mediaId: req.body?.proofMediaId },
    note: req.body?.note || '',
  });

  const family = await User.findById(payment.family);
  if (family) await notifyUser(family, M.refundIssued(payment.amount, payment.reference));

  res.json({ ok: true, payment, booking });
}));

/** Mark a nanny payout as transferred, with proof. */
router.post('/payouts/:id/mark-paid', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });

  await markPayoutPaid(payout, {
    adminId: req.admin?.id,
    proof: { url: req.body?.proofUrl, mediaId: req.body?.proofMediaId },
    note: req.body?.note || '',
  });

  const nanny = await User.findById(payout.nanny);
  if (nanny) {
    await notifyUser(nanny, `\u{1F4B0} *Payout sent \u{2014} ${money(payout.amount)}*\n\nWe have transferred your earnings.\nReference: ${payout.reference}`);
  }

  res.json({ ok: true, payout });
}));

/* ------------------------------------------------------------------ *
 * Support tickets
 * ------------------------------------------------------------------ */

router.get('/tickets', wrap(async (req, res) => {
  const { status, category } = req.query;
  const query = {};
  if (status) query.status = status;
  if (category) query.category = category;
  res.json(await paginate(Ticket, query, req.query, {
    sort: { createdAt: -1 },
    populate: [{ path: 'raisedBy', select: 'fullName phone role' }, { path: 'booking', select: 'bookingNumber' }],
  }));
}));

router.get('/tickets/:id', wrap(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id)
    .populate('raisedBy', 'fullName phone role email')
    .populate('booking');
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket });
}));

router.patch('/tickets/:id', wrap(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (req.body?.status) {
    ticket.status = req.body.status;
    if (req.body.status === TICKET_STATUS.RESOLVED) ticket.resolvedAt = new Date();
  }
  if (req.body?.priority) ticket.priority = req.body.priority;
  await ticket.save();
  res.json({ ok: true, ticket });
}));

/** Reply to a ticket; the reply is delivered over WhatsApp. */
router.post('/tickets/:id/reply', wrap(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).populate('raisedBy');
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Reply body is required' });

  ticket.replies.push({ from: 'admin', body });
  if (ticket.status === TICKET_STATUS.OPEN) ticket.status = TICKET_STATUS.IN_PROGRESS;
  await ticket.save();

  await notifyUser(ticket.raisedBy, `🆘 *Support reply — Ticket ${ticket.ticketNumber}*\n\n${body}`);
  res.json({ ok: true, ticket });
}));

/* ------------------------------------------------------------------ *
 * Chats & message log
 * ------------------------------------------------------------------ */

router.get('/chats', wrap(async (req, res) => {
  res.json(await paginate(ChatThread, {}, req.query, {
    sort: { lastMessageAt: -1 },
    populate: [
      { path: 'family', select: 'fullName phone' },
      { path: 'nanny', select: 'fullName phone' },
      { path: 'booking', select: 'bookingNumber' },
    ],
  }));
}));

router.get('/chats/:id', wrap(async (req, res) => {
  const thread = await ChatThread.findById(req.params.id)
    .populate('family', 'fullName phone')
    .populate('nanny', 'fullName phone')
    .populate('booking', 'bookingNumber');
  if (!thread) return res.status(404).json({ error: 'Chat not found' });
  res.json({ chat: thread });
}));

router.get('/messages', wrap(async (req, res) => {
  const { phone, direction } = req.query;
  const query = {};
  if (phone) query.phone = new RegExp(escapeRe(phone));
  if (direction) query.direction = direction;
  res.json(await paginate(MessageLog, query, req.query, { sort: { createdAt: -1 } }));
}));

/** Send an ad-hoc WhatsApp message from the dashboard. */
router.post('/messages/send', wrap(async (req, res) => {
  const { phone, body } = req.body || {};
  if (!phone || !body) return res.status(400).json({ error: 'phone and body are required' });
  const result = await notifyPhone(phone, body, { role: 'admin' });
  res.json({ ok: !!result.sent, result });
}));

/* ------------------------------------------------------------------ *
 * Settings / admins
 * ------------------------------------------------------------------ */

/**
 * Send a real verification email and report exactly what the provider said.
 *
 * Mail failures are otherwise invisible from outside the server logs, and a
 * rejected send blocks every signup, so this makes the cause checkable from
 * the dashboard.
 */
router.post('/settings/test-email', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const to = req.body?.to || req.admin?.email;
  if (!to) return res.status(400).json({ error: 'No recipient given' });

  const { sendVerificationCode, activeProvider } = await import('../providers/email.js');
  const provider = activeProvider();

  try {
    const result = await sendVerificationCode(to, '123456');
    res.json({
      ok: true,
      provider,
      to,
      messageId: result?.messageId || null,
      note: provider === 'console'
        ? 'No email provider is configured, so the code was only logged.'
        : 'Sent. Check the inbox, including spam.',
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      provider,
      to,
      error: err.message,
      // Resend refuses any recipient other than the account owner until a
      // sending domain is verified, which is the usual cause here.
      hint: /verif|domain|testing emails|own email/i.test(err.message)
        ? 'Resend only allows sending to your own account email until you verify a domain. Add a domain in Resend > Domains, then set RESEND_FROM to an address on it.'
        : /api key/i.test(err.message)
          ? 'RESEND_API_KEY is missing or wrong. Copy it again from Resend > API Keys.'
          : 'Check RESEND_API_KEY and RESEND_FROM on the server.',
    });
  }
}));

router.get('/settings', (req, res) => {
  res.json({
    currency: config.currency,
    transportFee: config.transportFee,
    newBookingResponseMinutes: config.newBookingResponseMinutes,
    changeBookingResponseMinutes: config.changeBookingResponseMinutes,
    reschedulePenaltyPercent: config.reschedulePenaltyPercent,
    freeRescheduleLimit: config.freeRescheduleLimit,
    liveLocationWindowHours: config.liveLocationWindowHours,
    whatsappConfigured: !!(config.ultramsg.instanceId && config.ultramsg.token),
    emailConfigured: !!(config.resend.apiKey || config.smtp.host),
    emailProvider: config.resend.apiKey ? 'Resend' : config.smtp.host ? 'SMTP' : null,
    bank: config.bank,
    bankConfigured: !!(config.bank.accountNumber || config.bank.iban),
  });
});

router.get('/admins', requireRole('super_admin'), wrap(async (req, res) => {
  const admins = await AdminUser.find().select('-passwordHash').sort({ createdAt: -1 });
  res.json({ items: admins });
}));

router.post('/admins', requireRole('super_admin'), wrap(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const exists = await AdminUser.findOne({ email: String(email).toLowerCase() });
  if (exists) return res.status(409).json({ error: 'An admin with that email already exists' });

  const admin = await AdminUser.create({
    email: String(email).toLowerCase(),
    passwordHash: await bcrypt.hash(password, 10),
    name, role: role || 'admin',
  });
  res.status(201).json({ ok: true, admin: { id: admin._id, email: admin.email, name: admin.name, role: admin.role } });
}));

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shared list endpoint pagination. */
async function paginate(Model, query, { page = 1, limit = 25 }, options = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));

  let q = Model.find(query).sort(options.sort || { createdAt: -1 }).skip((p - 1) * l).limit(l);
  for (const pop of options.populate || []) q = q.populate(pop);

  const [items, total] = await Promise.all([q, Model.countDocuments(query)]);
  return { items, total, page: p, limit: l, pages: Math.ceil(total / l) };
}

export default router;
