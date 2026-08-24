import express from 'express';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import {
  User, Booking, Ticket, ChatThread, MessageLog, AdminUser, Session,
} from '../models/index.js';
import { Payment, Payout } from '../models/Payment.js';
import {
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, PAYMENT_STATUS, PAYOUT_STATUS,
  TICKET_STATUS, CANCELLED_BY, SERVICE_DAY_STATUS,
} from '../utils/constants.js';
import { signToken, requireAuth, requireRole } from '../middleware/auth.js';
import { cancelBooking, markNannyCancelled } from '../services/booking.js';
import { refundBooking, releaseDuePayouts, queuePayout } from '../services/payments.js';
import { computeCancellationRefund } from '../services/policy.js';
import { notifyUser, notifyPhone } from '../services/notify.js';
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

  res.json({
    users: { families: totalFamilies, nannies: totalNannies, pendingNannies, verifiedNannies },
    bookings: {
      active: activeBookings, upcoming: upcomingBookings,
      completed: completedBookings, cancelled: cancelledBookings,
      total: activeBookings + upcomingBookings + completedBookings + cancelledBookings,
    },
    revenue: {
      total: revenueAgg, thisWeek: weekRevenueAgg,
      thisMonth: monthRevenueAgg, refunded: refundAgg,
    },
    support: { openTickets },
    trend,
  });
}));

async function sumPayments(match) {
  const [row] = await Payment.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total || 0;
}

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
  res.json(await paginate(User, query, req.query, { sort: { createdAt: -1 } }));
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
  res.json(await paginate(User, query, req.query, { sort: { createdAt: -1 } }));
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
    populate: [{ path: 'family', select: 'fullName phone' }, { path: 'booking', select: 'bookingNumber' }],
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

  const [familyWeek, nannyWeek, pendingNannies] = await Promise.all([
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.COMPLETED, kind: { $ne: 'refund' }, createdAt: { $gte: weekStart, $lte: weekEnd } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payout.aggregate([
      { $match: { scheduledFor: { $gte: weekStart, $lte: weekEnd } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    User.countDocuments({ role: USER_ROLE.NANNY, nannyStatus: NANNY_STATUS.PENDING_VERIFICATION }),
  ]);

  res.json({
    familyPaymentsThisWeek: { total: familyWeek[0]?.total || 0, count: familyWeek[0]?.count || 0 },
    nannyPaymentsThisWeek: { total: nannyWeek[0]?.total || 0, count: nannyWeek[0]?.count || 0 },
    deletePendingNanny: { count: pendingNannies },
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

router.post('/payments/:id/refund', requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  const booking = await Booking.findById(payment.booking);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const amount = Number(req.body?.amount ?? payment.amount);
  const result = await refundBooking(booking, { amount, reason: req.body?.reason || 'Manual admin refund' });
  res.json({ ok: result.success, refund: result.payment });
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
