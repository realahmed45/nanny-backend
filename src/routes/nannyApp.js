import express from 'express';
import dayjs from 'dayjs';
import {
  User, Booking, Otp, ChatThread, Payout,
} from '../models/index.js';
import {
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, SERVICE_DAY_STATUS,
} from '../utils/constants.js';
import { signNannyToken, requireNanny } from '../middleware/nannyAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { normalizePhone, sendText } from '../providers/ultramsg.js';
import { generateOtp } from '../flows/common.js';
import config from '../config/index.js';

/**
 * The API behind the nanny phone app.
 *
 * A third door into the same rules. The dashboard's API answers "show me
 * everything" and the WhatsApp flow answers "what is the next question" —
 * neither shape suits a screen that wants a month of bookings in one request.
 *
 * Nothing here re-implements a rule. Availability, matching, booking states
 * and payouts all already exist and are used as they are; this only reshapes
 * what they return. Where a rule is missing it is added to the service that
 * owns it, not here.
 *
 * Every route is scoped to the signed-in nanny by construction — her id comes
 * from her token, never from the request — so there is no path where one nanny
 * can name another and read her data.
 */

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

/**
 * Codes are short-lived and few.
 *
 * Without a limit this endpoint sends WhatsApp messages to any number a
 * stranger types, which is both a bill and a way to harass someone.
 */
const requestLimiter = rateLimit({
  max: 5,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  by: (req) => [
    `nanny-code:ip:${req.ip}`,
    req.body?.phone ? `nanny-code:phone:${normalizePhone(req.body.phone)}` : null,
  ],
});

const verifyLimiter = rateLimit({
  max: 8,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  by: (req) => [`nanny-verify:ip:${req.ip}`],
});

/**
 * Send a sign-in code over WhatsApp.
 *
 * Always answers the same way, whether or not the number belongs to a nanny.
 * Saying "no account here" would turn this into a way to discover which
 * numbers are registered with us.
 */
router.post('/auth/request-code', requestLimiter, wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone || '');
  const generic = { ok: true, message: 'If that number is registered, a code is on its way.' };

  if (!phone) return res.status(400).json({ error: 'A phone number is required' });

  const nanny = await User.findOne({ role: USER_ROLE.NANNY, phone });
  if (!nanny || nanny.blocked) return res.json(generic);

  await Otp.deleteMany({ phone, purpose: 'nanny_login' });
  const code = generateOtp();
  await Otp.create({
    phone,
    code,
    purpose: 'nanny_login',
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });

  await sendText(phone, `🔐 Your ${config.brand.name} app code is *${code}*.\n\nIt expires in 10 minutes. If you did not ask for it, ignore this message.`)
    .catch((err) => console.error(`[nanny-app] could not send code: ${err.message}`));

  return res.json(generic);
}));

/** Exchange a code for a token. */
router.post('/auth/verify', verifyLimiter, wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone || '');
  const code = String(req.body?.code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required' });

  const record = await Otp.findOne({ phone, code, purpose: 'nanny_login', consumed: false });
  if (!record) return res.status(401).json({ error: 'That code is not right. Please check and try again.' });
  if (new Date(record.expiresAt) < new Date()) {
    return res.status(401).json({ error: 'That code has expired. Please ask for a new one.' });
  }

  const nanny = await User.findOne({ role: USER_ROLE.NANNY, phone });
  if (!nanny) return res.status(401).json({ error: 'Account not found' });

  record.consumed = true;
  await record.save();

  nanny.lastSeenAt = new Date();
  await nanny.save();

  return res.json({
    token: signNannyToken(nanny),
    nanny: publicProfile(nanny),
  });
}));

/* ------------------------------------------------------------------ *
 * Everything below needs a signed-in nanny
 * ------------------------------------------------------------------ */

router.use(requireNanny);

/** What the app is allowed to know about her. */
function publicProfile(n) {
  return {
    id: n._id,
    fullName: n.fullName,
    nickname: n.nickname,
    phone: n.phone,
    email: n.email,
    age: n.age,
    experienceYears: n.experienceYears,
    languages: n.languages,
    skills: n.skills,
    subjects: n.subjects,
    cprCertified: n.cprCertified,
    status: n.nannyStatus,
    verified: n.nannyStatus === NANNY_STATUS.VERIFIED,
    ratingAverage: n.ratingAverage,
    ratingCount: n.ratingCount,
    profilePhotoUrl: n.profilePhotoUrl,
    availability: n.availability,
    emergencyAvailable: isEmergencyLive(n),
    emergencyAvailableUntil: n.emergencyAvailableUntil,
    // What is still missing, so the app can nudge rather than leave her
    // wondering why no work arrives.
    missing: [
      !n.nickname && 'nickname',
      !n.age && 'age',
      !(n.languages || []).length && 'languages',
      !(n.skills || []).length && 'skills',
      !(n.documents || []).some((d) => d.type === 'id_front') && 'ID photo',
      !(n.profilePictures || []).some((p) => p.approved) && 'profile picture',
    ].filter(Boolean),
  };
}

/** The switch expires on its own, so a stale "yes" is not treated as live. */
function isEmergencyLive(n) {
  if (!n.emergencyAvailable) return false;
  if (!n.emergencyAvailableUntil) return true;
  return new Date(n.emergencyAvailableUntil) > new Date();
}

router.get('/me', wrap(async (req, res) => {
  res.json({ nanny: publicProfile(req.nanny) });
}));

/* ------------------------------------------------------------------ *
 * Calendar
 * ------------------------------------------------------------------ */

/**
 * A month in one request.
 *
 * The screen needs every day of a month at once; asking per day would be
 * thirty round trips on a phone connection. Each day says what it is —
 * booked, blocked, or free — so the calendar colours itself without the app
 * having to work anything out.
 */
router.get('/calendar', wrap(async (req, res) => {
  const month = String(req.query.month || dayjs().format('YYYY-MM'));
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must look like 2026-09' });
  }

  const from = dayjs(`${month}-01`).startOf('month');
  const to = from.endOf('month');

  const bookings = await Booking.find({
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
    status: { $nin: [BOOKING_STATUS.DRAFT, BOOKING_STATUS.CANCELLED] },
    'serviceDays.date': { $gte: from.format('YYYY-MM-DD'), $lte: to.format('YYYY-MM-DD') },
  }).populate('family', 'fullName').lean();

  const blocked = new Set(req.nanny.availability?.blockedDates || []);

  // One entry per day that has anything on it, rather than a full month of
  // empty objects the app would have to filter.
  const byDate = {};
  for (const b of bookings) {
    for (const d of b.serviceDays || []) {
      if (d.date < from.format('YYYY-MM-DD') || d.date > to.format('YYYY-MM-DD')) continue;
      if (d.status === SERVICE_DAY_STATUS.CANCELLED) continue;
      (byDate[d.date] ||= []).push({
        bookingId: b._id,
        bookingNumber: b.bookingNumber,
        family: b.family?.fullName,
        startAt: d.startAt,
        endAt: d.endAt,
        hours: d.hours,
        status: d.status,
        isEmergency: b.isEmergency,
        address: b.address?.addressLine,
      });
    }
  }

  const days = [];
  for (let d = from; d.isBefore(to) || d.isSame(to, 'day'); d = d.add(1, 'day')) {
    const date = d.format('YYYY-MM-DD');
    const work = byDate[date] || [];
    days.push({
      date,
      blocked: blocked.has(date),
      bookings: work,
      state: work.length ? 'booked' : blocked.has(date) ? 'blocked' : 'free',
    });
  }

  return res.json({ month, days });
}));

/* ------------------------------------------------------------------ *
 * Days off
 * ------------------------------------------------------------------ */

/**
 * Block or unblock dates.
 *
 * A date she is already booked on is refused rather than blocked. Blocking it
 * would leave a family with a nanny who has quietly marked herself away, and
 * nobody would find out until the day. The booking has to be cancelled
 * properly first, which is a conversation, not a toggle.
 */
router.patch('/availability/dates', wrap(async (req, res) => {
  const add = (req.body?.block || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const remove = (req.body?.unblock || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

  if (!add.length && !remove.length) {
    return res.status(400).json({ error: 'Nothing to change' });
  }

  if (add.length) {
    const clash = await Booking.find({
      nanny: req.nanny._id,
      status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
      'serviceDays.date': { $in: add },
    }).select('bookingNumber serviceDays').lean();

    const booked = new Set();
    for (const b of clash) {
      for (const d of b.serviceDays || []) {
        if (add.includes(d.date) && d.status !== SERVICE_DAY_STATUS.CANCELLED) booked.add(d.date);
      }
    }

    if (booked.size) {
      return res.status(409).json({
        error: 'You already have a booking on those days.',
        detail: 'Please cancel the booking first — blocking the day would leave the family without a nanny.',
        dates: [...booked].sort(),
      });
    }
  }

  const current = new Set(req.nanny.availability?.blockedDates || []);
  add.forEach((d) => current.add(d));
  remove.forEach((d) => current.delete(d));

  req.nanny.availability = {
    ...(req.nanny.availability?.toObject?.() ?? req.nanny.availability ?? {}),
    blockedDates: [...current].sort(),
  };
  req.nanny.markModified('availability');
  await req.nanny.save();

  return res.json({ ok: true, blockedDates: req.nanny.availability.blockedDates });
}));

/** Her usual working pattern. */
router.patch('/availability/pattern', wrap(async (req, res) => {
  const { WEEKDAYS } = await import('../utils/constants.js');
  const days = (req.body?.days || []).filter((d) => WEEKDAYS.includes(d));
  const startTime = String(req.body?.startTime || '').trim();
  const maxHours = Number(req.body?.maxHoursPerDay);

  if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'startTime must look like 09:00' });
  }
  if (req.body?.maxHoursPerDay !== undefined && (!Number.isFinite(maxHours) || maxHours < 1 || maxHours > 24)) {
    return res.status(400).json({ error: 'Hours per day must be between 1 and 24' });
  }

  const current = req.nanny.availability?.toObject?.() ?? req.nanny.availability ?? {};
  req.nanny.availability = {
    ...current,
    ...(days.length ? { days } : {}),
    ...(startTime ? { startTime } : {}),
    ...(Number.isFinite(maxHours) ? { maxHoursPerDay: maxHours } : {}),
  };
  req.nanny.markModified('availability');
  await req.nanny.save();

  return res.json({ ok: true, availability: req.nanny.availability });
}));

/* ------------------------------------------------------------------ *
 * Emergency availability
 * ------------------------------------------------------------------ */

/** How long "I am free now" stands before we stop believing it. */
const EMERGENCY_WINDOW_HOURS = 4;

/**
 * "I could take a job in the next hour."
 *
 * Expires by itself. A nanny who switches it on at breakfast and forgets is
 * worse than one who never switched it on: the job is offered to her, she
 * misses it, and a family waits while the clock runs.
 */
router.post('/emergency-availability', wrap(async (req, res) => {
  const on = req.body?.available !== false;
  const hours = Math.min(12, Math.max(1, Number(req.body?.hours) || EMERGENCY_WINDOW_HOURS));

  req.nanny.emergencyAvailable = on;
  req.nanny.emergencyAvailableUntil = on
    ? new Date(Date.now() + hours * 3600_000)
    : undefined;
  await req.nanny.save();

  return res.json({
    ok: true,
    emergencyAvailable: on,
    until: req.nanny.emergencyAvailableUntil,
    message: on
      ? `You will be offered urgent jobs for the next ${hours} hours.`
      : 'You will not be offered urgent jobs.',
  });
}));

/* ------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------ */

const bookingSummary = (b) => ({
  id: b._id,
  bookingNumber: b.bookingNumber,
  status: b.status,
  subStatus: b.subStatus,
  family: b.family?.fullName,
  startDate: b.startDate,
  endDate: b.endDate,
  startTime: b.startTime,
  hoursPerDay: b.hoursPerDay,
  days: (b.serviceDays || []).length,
  address: b.address,
  children: b.children,
  isEmergency: b.isEmergency,
  emergencySurcharge: b.emergencySurcharge,
  otherInstructions: b.otherInstructions,
  // What she earns, which is not what the family pays.
  hourlyRate: b.hourlyRate,
  totalAmount: b.totalAmount,
});

router.get('/bookings', wrap(async (req, res) => {
  const group = String(req.query.group || 'upcoming');
  const filters = {
    upcoming: { status: BOOKING_STATUS.UPCOMING },
    ongoing: { status: BOOKING_STATUS.ONGOING },
    past: { status: { $in: [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.CANCELLED] } },
  };
  if (!filters[group]) return res.status(400).json({ error: 'Unknown group' });

  const items = await Booking.find({
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
    ...filters[group],
  })
    .populate('family', 'fullName')
    .sort({ startDate: group === 'past' ? -1 : 1 })
    .limit(100)
    .lean();

  return res.json({ items: items.map(bookingSummary) });
}));

router.get('/bookings/:id', wrap(async (req, res) => {
  const b = await Booking.findOne({
    _id: req.params.id,
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
  }).populate('family', 'fullName').lean();

  if (!b) return res.status(404).json({ error: 'Booking not found' });
  return res.json({ booking: { ...bookingSummary(b), serviceDays: b.serviceDays } });
}));

/** Requests waiting on her answer, with how long is left. */
router.get('/requests', wrap(async (req, res) => {
  const bookings = await Booking.find({
    nanny: req.nanny._id,
    'nannyResponses': { $elemMatch: { nanny: req.nanny._id, outcome: 'pending' } },
  }).populate('family', 'fullName').lean();

  const items = bookings.map((b) => {
    const pending = (b.nannyResponses || []).find(
      (r) => String(r.nanny) === String(req.nanny._id) && r.outcome === 'pending',
    );
    return {
      ...bookingSummary(b),
      expiresAt: pending?.expiresAt,
      minutesLeft: pending?.expiresAt
        ? Math.max(0, Math.round((new Date(pending.expiresAt) - Date.now()) / 60000))
        : null,
    };
  });

  return res.json({ items });
}));

/**
 * Accept or decline, reusing the flow the bot already runs.
 *
 * Imported rather than reimplemented: the rules about response windows,
 * replacements and notifying the family are involved, and a second copy would
 * drift from the first.
 */
router.post('/requests/:id/respond', wrap(async (req, res) => {
  const accept = req.body?.accept === true;
  const booking = await Booking.findOne({ _id: req.params.id, nanny: req.nanny._id });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const pending = (booking.nannyResponses || []).find(
    (r) => String(r.nanny) === String(req.nanny._id) && r.outcome === 'pending',
  );
  if (!pending) return res.status(409).json({ error: 'This request is no longer waiting on you' });
  if (new Date(pending.expiresAt) < new Date()) {
    return res.status(409).json({ error: 'The time to respond has passed' });
  }

  const { respondToBookingRequest } = await import('../services/nannyResponse.js');
  const result = await respondToBookingRequest({
    booking,
    nanny: req.nanny,
    accept,
    reason: String(req.body?.reason || '').slice(0, 200),
  });

  return res.json({ ok: true, ...result });
}));

/* ------------------------------------------------------------------ *
 * Earnings
 * ------------------------------------------------------------------ */

router.get('/earnings', wrap(async (req, res) => {
  const [completed, payouts] = await Promise.all([
    Booking.find({
      nanny: req.nanny._id,
      status: BOOKING_STATUS.COMPLETED,
    }).select('bookingNumber totalAmount completedAt startDate').sort({ completedAt: -1 }).limit(50).lean(),
    Payout.find({ nanny: req.nanny._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  const earned = completed.reduce((s, b) => s + (b.totalAmount || 0), 0);
  const paid = payouts.filter((p) => p.status === 'paid').reduce((s, p) => s + (p.amount || 0), 0);

  return res.json({
    earned,
    paid,
    pending: Math.max(0, earned - paid),
    recentBookings: completed,
    payouts,
  });
}));

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

router.get('/chats', wrap(async (req, res) => {
  const threads = await ChatThread.find({ nanny: req.nanny._id })
    .populate('family', 'fullName')
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .lean();

  return res.json({
    items: threads.map((t) => ({
      id: t._id,
      family: t.family?.fullName,
      booking: t.booking,
      lastMessageAt: t.lastMessageAt,
      closed: t.closed,
      preview: (t.messages || []).at(-1)?.body?.slice(0, 80) || '',
    })),
  });
}));

router.get('/chats/:id', wrap(async (req, res) => {
  const t = await ChatThread.findOne({ _id: req.params.id, nanny: req.nanny._id })
    .populate('family', 'fullName').lean();
  if (!t) return res.status(404).json({ error: 'Conversation not found' });

  return res.json({
    id: t._id,
    family: t.family?.fullName,
    messages: (t.messages || []).map((m) => ({
      from: m.from, body: m.body, mediaUrl: m.mediaUrl, at: m.createdAt || m.sentAt,
    })),
  });
}));

/**
 * Send into a thread.
 *
 * The family reads it in WhatsApp, so this goes through the same relay the
 * bot uses — including the filter that strips phone numbers, because the
 * whole point of the relay is that neither side gets the other's details.
 */
router.post('/chats/:id/messages', wrap(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message is empty' });

  const thread = await ChatThread.findOne({ _id: req.params.id, nanny: req.nanny._id });
  if (!thread) return res.status(404).json({ error: 'Conversation not found' });
  if (thread.closed) return res.status(409).json({ error: 'This conversation is closed' });

  const { redactContactDetails } = await import('../utils/contactFilter.js');
  const safe = redactContactDetails(body);

  thread.messages.push({ from: 'nanny', sender: req.nanny._id, body: safe.text });
  thread.lastMessageAt = new Date();
  thread.nannyActive = true;
  await thread.save();

  const family = await User.findById(thread.family);
  if (family) {
    const { notifyUser } = await import('../services/notify.js');
    const { nannyDisplayName } = await import('../utils/format.js');
    await notifyUser(family, `👩 ${nannyDisplayName(req.nanny)}:\n${safe.text}`).catch(() => {});
  }

  return res.json({ ok: true, redacted: safe.redacted });
}));

/* ------------------------------------------------------------------ *
 * Push notifications
 * ------------------------------------------------------------------ */

/** Register this phone, so an urgent job can actually reach her. */
router.post('/push-token', wrap(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const platform = ['android', 'ios', 'web'].includes(req.body?.platform)
    ? req.body.platform : 'android';
  if (!token) return res.status(400).json({ error: 'Token is required' });

  req.nanny.pushTokens = (req.nanny.pushTokens || []).filter((t) => t.token !== token);
  req.nanny.pushTokens.push({ token, platform, registeredAt: new Date() });
  // A phone that has been signed into many times should not accumulate
  // entries forever; the recent ones are the ones that still exist.
  if (req.nanny.pushTokens.length > 5) {
    req.nanny.pushTokens = req.nanny.pushTokens.slice(-5);
  }
  await req.nanny.save();

  return res.json({ ok: true });
}));

router.delete('/push-token', wrap(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  req.nanny.pushTokens = (req.nanny.pushTokens || []).filter((t) => t.token !== token);
  await req.nanny.save();
  return res.json({ ok: true });
}));

export default router;
