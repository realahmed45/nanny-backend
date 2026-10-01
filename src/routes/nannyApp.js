import crypto from 'node:crypto';
import express from 'express';
import dayjs from 'dayjs';
import {
  User, Booking, Otp, ChatThread, Payout,
} from '../models/index.js';
import {
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, SERVICE_DAY_STATUS, PAYOUT_STATUS,
} from '../utils/constants.js';
import { dayWorkers, rateForDay } from '../services/payments.js';
import { round2 } from '../services/policy.js';
import { signNannyToken, requireNanny } from '../middleware/nannyAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { normalizePhone, sendText } from '../providers/ultramsg.js';
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
 * The ways one Indonesian number gets written by hand.
 *
 * She registered over WhatsApp, which gave us 6281234567890. Typing her own
 * number into a box, she writes 0812-3456-7890 — that is how it is written
 * here, and a code that never arrives for the version on her own paperwork is
 * a dead end that ends in a phone call to us.
 *
 * Only tried at sign-in, where a person is typing. Everywhere else the number
 * arrives from WhatsApp already in one shape, and guessing there would be a
 * way to match the wrong person.
 */
function phoneVariants(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return [];

  const out = new Set([digits]);
  if (digits.startsWith('0')) out.add(`62${digits.slice(1)}`);
  if (digits.startsWith('62')) out.add(`0${digits.slice(2)}`);
  return [...out];
}

/**
 * One spelling per number, for counting attempts against it.
 *
 * Keyed on the raw digits, "0812…" and "62812…" would be two separate buckets
 * for the same person, so the per-number limit could be doubled just by
 * switching how the number was written.
 */
function phoneKey(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return null;
  return digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
}

/**
 * Codes are short-lived and few.
 *
 * Without a limit this endpoint sends WhatsApp messages to any number a
 * stranger types, which is both a bill and a way to harass someone. Counted by
 * address and by number: one address is easy to rotate, and one number
 * hammered from many addresses is the harassment case.
 */
const requestLimiter = rateLimit({
  max: 5,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  by: (req) => [`nanny-code:ip:${req.ip}`],
});
const requestPhoneLimiter = rateLimit({
  max: 3,
  windowMs: 15 * 60_000,
  lockMs: 30 * 60_000,
  by: (req) => {
    const key = phoneKey(req.body?.phone);
    return [key ? `nanny-code:phone:${key}` : null];
  },
});

/**
 * Guessing a six-digit code.
 *
 * Per address and per number. Per address alone lets many machines share out
 * the guesses; per number alone lets one address try every nanny. The code
 * itself also dies after MAX_CODE_ATTEMPTS wrong tries, so even a patient
 * attacker under both limits only ever gets a handful of guesses at any one
 * code before a new one has to be sent — to her phone, not theirs.
 */
const verifyLimiter = rateLimit({
  max: 8,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  by: (req) => [`nanny-verify:ip:${req.ip}`],
});
const verifyPhoneLimiter = rateLimit({
  max: 6,
  windowMs: 15 * 60_000,
  lockMs: 30 * 60_000,
  by: (req) => {
    const key = phoneKey(req.body?.phone);
    return [key ? `nanny-verify:phone:${key}` : null];
  },
});

/** Wrong codes allowed against one issued code before it is thrown away. */
const MAX_CODE_ATTEMPTS = 5;
const CODE_TTL_MS = 10 * 60_000;

/**
 * Phone-number-only sign-in, switched off.
 *
 * This used to hand a ninety-day token to anyone who typed a registered
 * nanny's number — and a phone number is not a secret: it is on every message
 * she has ever sent a family. That token opens the addresses of the families
 * she works for and their children's details. It also answered "We could not
 * find that number" for an unregistered one, so it doubled as a way to check
 * which numbers belong to our nannies.
 *
 * Kept as a route only so an old copy of the app still on a phone gets a
 * sentence telling her to update, rather than a bare 404. It never looks
 * anything up and never issues a token.
 */
router.post('/auth/sign-in', (req, res) => res.status(410).json({
  error: 'Please update the app. Signing in now uses a code we send you on WhatsApp.',
  codeRequired: true,
}));

/**
 * Step one: send a code to her WhatsApp.
 *
 * The reply is the same whether or not the number belongs to a nanny — same
 * status, same body — and the send is not awaited, so the time taken does not
 * give it away either. Anything else turns this into a way to find out which
 * numbers are registered with us.
 *
 * Only a real, open nanny account is actually sent a code. A family's number,
 * an unknown one, or a blocked or suspended nanny gets the same polite reply
 * and nothing on the phone.
 */
router.post('/auth/request-code', requestLimiter, requestPhoneLimiter, wrap(async (req, res) => {
  const variants = phoneVariants(req.body?.phone || '');
  const generic = { ok: true, message: 'If that number is registered, a code is on its way on WhatsApp.' };

  if (!variants.length || variants[0].length < 8) {
    return res.status(400).json({ error: 'Enter the phone number you registered with.' });
  }

  const nanny = await User.findOne({ role: USER_ROLE.NANNY, phone: { $in: variants } });
  if (!nanny || nanny.blocked || nanny.nannyStatus === NANNY_STATUS.SUSPENDED) {
    return res.json(generic);
  }

  // Filed under the number as we hold it, not as she typed it, so verify finds
  // it whichever way she writes it the second time.
  const { phone } = nanny;
  await Otp.deleteMany({ phone, purpose: 'nanny_login' });
  // crypto rather than Math.random: this code is now the whole of the login.
  const code = String(crypto.randomInt(100000, 1000000));
  await Otp.create({
    phone,
    code,
    purpose: 'nanny_login',
    attempts: 0,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  sendText(phone, `🔐 Your ${config.brand.name} app code is *${code}*.\n\nIt expires in 10 minutes. Never share it — we will never ask you for it. If you did not ask for it, ignore this message.`)
    .catch((err) => console.error(`[nanny-app] could not send code: ${err.message}`));

  return res.json(generic);
}));

/** Constant-time comparison, so response timing says nothing about the code. */
function sameCode(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Step two: exchange the code for a token.
 *
 * Every failure gets the same answer, so this cannot tell a registered number
 * from an unregistered one either. Each wrong guess counts against the code
 * itself and the code is discarded after MAX_CODE_ATTEMPTS — the rate limits
 * alone would still allow hundreds of guesses over a day, which is a real
 * chance at six digits.
 */
router.post('/auth/verify', verifyLimiter, verifyPhoneLimiter, wrap(async (req, res) => {
  const variants = phoneVariants(req.body?.phone || '');
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!variants.length || !code) return res.status(400).json({ error: 'Phone and code are required' });

  const wrong = { error: 'That code is not right, or it has expired. Check it, or ask for a new one.' };

  const record = await Otp.findOne({
    phone: { $in: variants }, purpose: 'nanny_login', consumed: false,
  }).sort({ createdAt: -1 });
  if (!record || new Date(record.expiresAt) < new Date()) return res.status(401).json(wrong);

  if (!sameCode(record.code, code)) {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= MAX_CODE_ATTEMPTS) record.consumed = true;
    await record.save();
    return res.status(401).json(wrong);
  }

  // Burned atomically before anything else, so one code cannot be raced into
  // two sessions.
  const burned = await Otp.updateOne(
    { _id: record._id, consumed: false },
    { $set: { consumed: true } },
  );
  if (!burned.modifiedCount) return res.status(401).json(wrong);

  const nanny = await User.findOne({ role: USER_ROLE.NANNY, phone: record.phone });
  if (!nanny) return res.status(401).json(wrong);
  if (nanny.blocked || nanny.nannyStatus === NANNY_STATUS.SUSPENDED) {
    return res.status(403).json({ error: 'Your account is on hold. Please message us on WhatsApp.' });
  }

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

/**
 * What she earns on a booking: her own rate on every day not cancelled.
 *
 * The app labels `totalAmount` "What you earn", and it used to be sent the
 * family's price — so every nanny was shown the full amount the family pays,
 * and with it our commission. The field keeps its name so the app already in
 * nannies' hands shows the right figure without an update.
 */
/*
 * Summed from `dayWorkers`, the same per-day split payouts use. Working it out
 * here from her rate × the day's hours showed each nanny on a two-nanny 24h
 * booking the whole day's pay, when she is paid for her own shift (half), and
 * left out the emergency bonus for the nanny who claimed the job. A day she is
 * not working on (the other nanny's, or before she joined) counts as nothing.
 */
function nannyPay(b, nannyId) {
  const rate = rateForDay(b, null, nannyId);
  const me = String(nannyId);
  const days = (b.serviceDays || []).filter((d) => d.status !== SERVICE_DAY_STATUS.CANCELLED);
  return {
    rate,
    total: round2(days.reduce((sum, d) => {
      const mine = dayWorkers(b, d).find((w) => String(w.nannyId) === me);
      return sum + (mine?.base || 0);
    }, 0)),
  };
}

/**
 * Is this still a job she is doing, so she still needs to know where and for whom?
 *
 * The past list returned cancelled bookings in full — the family's address,
 * the map pin, every child's name, age and allergies, the free-text
 * instructions — long after she was taken off the job or the family called it
 * off. A nanny removed for cause kept a permanent record of where the children
 * live. Once a booking is cancelled, or she is no longer one of its nannies,
 * she keeps the dates and her pay for it and nothing that locates the family.
 */
function stillHers(b, nannyId) {
  if (b.status === BOOKING_STATUS.CANCELLED) return false;
  const me = String(nannyId);
  const id = (v) => String(v?._id || v || '');
  return id(b.nanny) === me || id(b.secondNanny) === me;
}

const bookingSummary = (b, nannyId) => {
  const pay = nannyPay(b, nannyId);
  const current = stillHers(b, nannyId);
  return {
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
    // Withheld, not blanked to look like missing data: the app can say why.
    address: current ? b.address : null,
    children: current ? b.children : [],
    otherInstructions: current ? b.otherInstructions : undefined,
    detailsWithheld: !current,
    isEmergency: b.isEmergency,
    emergencySurcharge: b.emergencySurcharge,
    // What she earns, which is not what the family pays.
    hourlyRate: pay.rate,
    totalAmount: pay.total,
  };
};

router.get('/bookings', wrap(async (req, res) => {
  const group = String(req.query.group || 'upcoming');
  const filters = {
    // A booking waiting on a family top-up is still her job; it is sorted into
    // upcoming or ongoing below by whether its days have started.
    upcoming: { status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT] } },
    ongoing: { status: { $in: [BOOKING_STATUS.ONGOING, BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT] } },
    past: { status: { $in: [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.CANCELLED] } },
  };
  if (!filters[group]) return res.status(400).json({ error: 'Unknown group' });

  const found = await Booking.find({
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
    ...filters[group],
  })
    .populate('family', 'fullName')
    .sort({ startDate: group === 'past' ? -1 : 1 })
    .limit(100)
    .lean();

  const started = (b) => (b.serviceDays || []).some(
    (d) => ![SERVICE_DAY_STATUS.SCHEDULED, SERVICE_DAY_STATUS.CANCELLED].includes(d.status),
  );
  const items = found.filter((b) => {
    if (b.status !== BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT) return true;
    return group === 'ongoing' ? started(b) : !started(b);
  });

  return res.json({ items: items.map((b) => bookingSummary(b, req.nanny._id)) });
}));

router.get('/bookings/:id', wrap(async (req, res) => {
  const b = await Booking.findOne({
    _id: req.params.id,
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
  }).populate('family', 'fullName').lean();

  if (!b) return res.status(404).json({ error: 'Booking not found' });
  return res.json({
    booking: {
      ...bookingSummary(b, req.nanny._id),
      // Only what the app shows. The full day carried the family's price for
      // it and the family's arrival and end-of-service codes — the codes the
      // family gives her to prove she arrived and stayed.
      serviceDays: (b.serviceDays || []).map((d) => ({
        _id: d._id, date: d.date, startAt: d.startAt, endAt: d.endAt, status: d.status,
      })),
      // Only her own half of the sharing state. Whether the family is sharing
      // back is theirs to know.
      liveLocation: { nannySharing: !!b.liveLocation?.nannySharing },
    },
  });
}));

/** Requests waiting on her answer, with how long is left. */
/*
 * Matched on either seat. The second nanny on a 24h booking is asked too, but
 * these used to look only at `nanny`, so her requests never appeared and her
 * answer was a 404 — she could only reply over WhatsApp, if at all.
 */
router.get('/requests', wrap(async (req, res) => {
  const bookings = await Booking.find({
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
    'nannyResponses': { $elemMatch: { nanny: req.nanny._id, outcome: 'pending' } },
  }).populate('family', 'fullName').lean();

  const items = bookings.map((b) => {
    const pending = (b.nannyResponses || []).find(
      (r) => String(r.nanny) === String(req.nanny._id) && r.outcome === 'pending',
    );
    return {
      ...bookingSummary(b, req.nanny._id),
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
  const booking = await Booking.findOne({
    _id: req.params.id,
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
  });
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

  /**
   * A refusal from the service is a refusal here.
   *
   * The result used to be spread into `{ ok: true, ...result }`, so a booking
   * the family had already cancelled, or a job taken by someone else, came
   * back as ok and the app showed her a confirmation for work she did not
   * have. It also sent the whole booking document — including the family's
   * arrival and end-of-service codes — to the app.
   */
  if (!result?.ok) {
    const message = {
      booking_closed: 'This booking has been closed or cancelled, so there is nothing to accept.',
      no_longer_available: 'This job is no longer available — it has been filled or changed.',
      expired: 'The time to respond has passed',
      no_pending_request: 'This request is no longer waiting on you',
    }[result?.reason] || 'This request could not be completed. Please check your bookings.';
    return res.status(409).json({ ok: false, reason: result?.reason, error: message });
  }

  return res.json({
    ok: true,
    accepted: !!result.accepted,
    isChange: !!result.isChange,
    bookingId: booking._id,
  });
}));

/* ------------------------------------------------------------------ *
 * Earnings
 * ------------------------------------------------------------------ */

/**
 * One payout, as she is allowed to see it.
 *
 * The whole record used to be sent: the office's internal notes, why a
 * transfer failed, which admin released or reviewed it, and the links to the
 * proof photos. None of that is hers to read, and an advance's `reason` is the
 * personal detail the month-end wipe exists to remove. This is what a payslip
 * would show, and nothing more.
 */
function payoutForApp(p) {
  return {
    id: p._id,
    reference: p.reference,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    kind: p.kind || 'earnings',
    scheduledFor: p.scheduledFor,
    releasedAt: p.releasedAt,
    bookingNumber: p.booking?.bookingNumber,
    advanceRecovered: p.advanceRecovered || 0,
    // Why a salary was smaller than the day's pay: our share of overtime the
    // family paid her in cash. She needs this to check her money; the rest of
    // the overtime breakdown is office bookkeeping.
    overtime: p.overtime?.commissionDeducted || p.overtime?.stillOwed
      ? {
        commissionDeducted: p.overtime.commissionDeducted || 0,
        stillOwed: p.overtime.stillOwed || 0,
      }
      : undefined,
  };
}

router.get('/earnings', wrap(async (req, res) => {
  const [completed, payouts] = await Promise.all([
    Booking.find({
      $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
      status: BOOKING_STATUS.COMPLETED,
    }).select('bookingNumber completedAt startDate').sort({ completedAt: -1 }).limit(50).lean(),
    Payout.find({ nanny: req.nanny._id })
      .populate('booking', 'bookingNumber')
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  /**
   * Built from her payouts, which are what she is actually owed and sent.
   *
   * This used to add up the family's price for each booking as "earned" and
   * count payouts with status 'paid' as "paid" — a status that does not exist,
   * so every nanny was shown the family's full price as owed to her and Rp 0
   * paid, however much she had been sent.
   */
  const settled = new Set([PAYOUT_STATUS.COMPLETED, PAYOUT_STATUS.FINAL_DONE]);
  const open = new Set([PAYOUT_STATUS.PENDING, PAYOUT_STATUS.PROCESSING]);

  const paid = round2(payouts
    .filter((p) => settled.has(p.status))
    .reduce((s, p) => s + (p.amount || 0), 0));

  /**
   * An advance is counted once, as money she already has.
   *
   * A paid advance is in `paid` above. The wages it was drawn against are
   * still queued at their full amount — the advance only comes off them when
   * the salary is released — so adding the two counted the advance twice:
   * a nanny who drew 1,000,000 early against a 3,000,000 month was shown
   * 4,000,000 earned. Whatever of an advance is still to be recovered is
   * taken off what is still to come, which is what she will actually receive.
   */
  const outstandingAdvance = round2(payouts
    .filter((p) => p.kind === 'advance' && settled.has(p.status) && (p.advance?.outstanding || 0) > 0)
    .reduce((s, p) => s + (p.advance.outstanding || 0), 0));
  const queued = round2(payouts
    .filter((p) => open.has(p.status) && p.kind !== 'advance')
    .reduce((s, p) => s + (p.amount || 0), 0));
  const pending = round2(Math.max(0, queued - outstandingAdvance));

  const byBooking = new Map();
  for (const p of payouts) {
    if (!p.booking || p.status === PAYOUT_STATUS.FAILED) continue;
    const key = String(p.booking._id || p.booking);
    byBooking.set(key, round2((byBooking.get(key) || 0) + (p.amount || 0)));
  }

  return res.json({
    earned: round2(paid + pending),
    paid,
    pending,
    // Shown so the drop from "queued" to "pending" is explained, not a mystery.
    advanceOutstanding: outstandingAdvance,
    // `totalAmount` is her pay on the booking, under the name the app reads.
    recentBookings: completed.map((b) => ({ ...b, totalAmount: byBooking.get(String(b._id)) || 0 })),
    payouts: payouts.slice(0, 50).map(payoutForApp),
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

  // Same filter, same direction as the WhatsApp side: what is stored and what
  // the family receives are both the redacted text.
  const { redactContactDetails } = await import('../utils/contactFilter.js');
  const safe = redactContactDetails(body);

  thread.messages.push({ from: 'nanny', sender: req.nanny._id, body: safe.text });
  thread.lastMessageAt = new Date();
  thread.nannyActive = true;
  await thread.save();

  /**
   * Relayed, not merely notified.
   *
   * This used `notifyUser(...).catch(() => {})` and answered ok regardless.
   * Two things went wrong with that. The family's WhatsApp session was left
   * wherever it was, so their reply was read as a menu choice and never came
   * back into this thread — from her side the family simply ignored her. And a
   * message that never left our server showed in her app as sent. The relay
   * moves the family into this chat (when it is safe to interrupt them) and
   * says whether the message actually went, and that is passed back to her.
   */
  const family = await User.findById(thread.family);
  let delivered = { sent: false, live: false, skipped: !family };
  if (family) {
    const { relayChatMessage } = await import('../services/notify.js');
    const { nannyDisplayName } = await import('../utils/format.js');
    try {
      delivered = await relayChatMessage(family, `👩 ${nannyDisplayName(req.nanny)}:\n${safe.text}`, {
        threadId: thread._id,
      });
    } catch (err) {
      console.error(`[nanny-app] chat relay failed for thread ${thread._id}: ${err.message}`);
      delivered = { sent: false, live: false, error: err.message };
    }
  }

  const sent = !delivered.skipped && delivered.sent !== false;
  if (!sent) {
    // Saved in the thread, so she must not resend it (that would duplicate
    // it); she is told it has not reached them yet.
    return res.status(502).json({
      ok: false,
      saved: true,
      delivered: false,
      redacted: safe.redacted,
      error: 'Your message is saved, but it did not reach the family. Please try again in a moment, or message us if it keeps happening.',
    });
  }

  return res.json({
    ok: true,
    delivered: true,
    // Whether the family is in the chat right now, so their next message
    // comes straight back here.
    live: !!delivered.live,
    redacted: safe.redacted,
  });
}));

/* ------------------------------------------------------------------ *
 * Her own profile and media
 * ------------------------------------------------------------------ */

/**
 * Edit the parts of her profile she owns.
 *
 * Name, status, rate and verification are not in this list. Those are decided
 * about her rather than by her, and an app that let her set her own verified
 * badge would make the badge meaningless.
 */
router.patch('/me', wrap(async (req, res) => {
  const b = req.body || {};
  const text = (v, max) => String(v).trim().slice(0, max);

  if (b.nickname !== undefined) req.nanny.nickname = text(b.nickname, 40);
  if (b.email !== undefined) req.nanny.email = text(b.email, 120);
  if (b.residingAddress !== undefined) req.nanny.residingAddress = text(b.residingAddress, 300);
  if (Array.isArray(b.subjects)) {
    req.nanny.subjects = b.subjects.slice(0, 20).map((x) => text(x, 60)).filter(Boolean);
  }
  if (b.cprCertified !== undefined) req.nanny.cprCertified = b.cprCertified === true;

  if (b.age !== undefined) {
    const age = Number(b.age);
    if (!Number.isFinite(age) || age < 16 || age > 80) {
      return res.status(400).json({ error: 'Age must be between 16 and 80' });
    }
    req.nanny.age = age;
  }

  if (b.experienceYears !== undefined) {
    const yrs = Number(b.experienceYears);
    if (!Number.isFinite(yrs) || yrs < 0 || yrs > 60) {
      return res.status(400).json({ error: 'Experience must be between 0 and 60 years' });
    }
    req.nanny.experienceYears = yrs;
  }

  await req.nanny.save();
  return res.json({ nanny: publicProfile(req.nanny) });
}));

/** Everything she has sent us, and where each item stands. */
router.get('/media', wrap(async (req, res) => {
  const shape = (m) => ({
    id: m._id,
    url: m.url,
    caption: m.caption,
    title: m.title,
    uploadedAt: m.uploadedAt,
    approved: !!m.approved,
    featured: !!m.featured,
    rejected: !!m.rejectedAt,
    // She is told why, in the words the admin picked. A rejection with no
    // reason just reads as the app being broken.
    rejectionReasons: m.rejectionReasons || [],
    rejectionDetail: m.rejectionDetail,
    status: m.rejectedAt ? 'rejected' : m.approved ? 'approved' : 'pending',
  });

  return res.json({
    videos: (req.nanny.videos || []).map(shape),
    photos: (req.nanny.photos || []).map(shape),
    profilePictures: (req.nanny.profilePictures || []).map(shape),
    documents: (req.nanny.documents || []).map((d) => ({
      id: d._id, type: d.type, url: d.url, uploadedAt: d.uploadedAt,
    })),
  });
}));

/** What may be sent, and what each one is called on the record. */
const MEDIA_KINDS = {
  video: { field: 'videos', exts: ['.mp4', '.mov', '.webm'] },
  photo: { field: 'photos', exts: ['.jpg', '.jpeg', '.png', '.webp'] },
  profile: { field: 'profilePictures', exts: ['.jpg', '.jpeg', '.png', '.webp'] },
  id_front: { field: 'documents', exts: ['.jpg', '.jpeg', '.png', '.webp', '.pdf'] },
  id_back: { field: 'documents', exts: ['.jpg', '.jpeg', '.png', '.webp', '.pdf'] },
  // Named to match the document enum on the record; a type outside it fails
  // validation on save, which would surface as a mystery 500 at upload time.
  cpr_certificate: { field: 'documents', exts: ['.jpg', '.jpeg', '.png', '.webp', '.pdf'] },
};

/**
 * Upload from the phone.
 *
 * Arrives as base64 rather than multipart: it is one file at a time from a
 * picker that already hands us the bytes, and it saves adding a file-upload
 * middleware and its temp directory to a server that has no other use for one.
 *
 * Nothing uploaded here is visible to a family. It lands in the same review
 * queue as anything sent over WhatsApp, unapproved, because these photos show
 * other people's children and that gate is the entire point of it.
 */
router.post('/media', wrap(async (req, res) => {
  const kind = String(req.body?.kind || '');
  const spec = MEDIA_KINDS[kind];
  if (!spec) return res.status(400).json({ error: 'Unknown upload type' });

  const raw = String(req.body?.ext || '').toLowerCase();
  const ext = raw.startsWith('.') ? raw : `.${raw}`;
  if (!spec.exts.includes(ext)) {
    return res.status(400).json({ error: `That file type is not accepted here (${spec.exts.join(', ')})` });
  }

  const base64 = String(req.body?.data || '').replace(/^data:[^,]+,/, '');
  if (!base64) return res.status(400).json({ error: 'No file was attached' });

  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'The file could not be read' });
  }

  const { storeBuffer } = await import('../services/mediaArchive.js');
  let url;
  try {
    /**
     * Identity documents are stored behind the dashboard login; photos and
     * videos are not, because WhatsApp fetches those from this server in order
     * to deliver them and a family would otherwise never see her picture.
     */
    url = await storeBuffer(buf, { ext, private: spec.field === 'documents' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const caption = String(req.body?.caption || '').trim().slice(0, 200);

  if (spec.field === 'documents') {
    // One of each kind. A second ID photo replaces the first rather than
    // stacking, or the queue fills with four pictures of the same card.
    req.nanny.documents = (req.nanny.documents || []).filter((d) => d.type !== kind);
    req.nanny.documents.push({ type: kind, url, uploadedAt: new Date() });
  } else {
    req.nanny[spec.field] = req.nanny[spec.field] || [];
    if (req.nanny[spec.field].some((m) => m.url === url)) {
      return res.status(409).json({ error: 'You have already sent this one.' });
    }
    req.nanny[spec.field].push({
      url,
      ...(kind === 'video' ? { title: caption } : { caption }),
      uploadedAt: new Date(),
      approved: false,
      featured: false,
    });
  }

  req.nanny.markModified(spec.field);
  await req.nanny.save();

  return res.status(201).json({
    ok: true,
    url,
    status: spec.field === 'documents' ? 'received' : 'pending',
    message: spec.field === 'documents'
      ? 'Received, thank you.'
      : 'Sent for review. We will let you know once it is approved.',
  });
}));

/**
 * Withdraw something she has sent.
 *
 * Only while it is still waiting. Once approved it may already be on her
 * public profile and in a family's chat, and pulling it out from under them
 * is a conversation with us, not a button.
 */
router.delete('/media/:field/:id', wrap(async (req, res) => {
  const field = ['videos', 'photos', 'profilePictures'].includes(req.params.field)
    ? req.params.field : null;
  if (!field) return res.status(400).json({ error: 'Unknown media type' });

  const list = req.nanny[field] || [];
  const item = list.find((m) => String(m._id) === String(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.approved) {
    return res.status(409).json({
      error: 'This one is already approved.',
      detail: 'Message us on WhatsApp and we will take it down for you.',
    });
  }

  req.nanny[field] = list.filter((m) => String(m._id) !== String(req.params.id));
  req.nanny.markModified(field);
  await req.nanny.save();
  return res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Live location
 * ------------------------------------------------------------------ */

/**
 * How long after a booking ends we keep listening.
 *
 * She is still walking to the road, waiting for a ride, or getting home from
 * a house she has never been to before. The family stops seeing her when the
 * booking ends; we keep the trail a little longer because that is the window
 * in which something going wrong is our problem to answer for.
 */
const LOCATION_TAIL_MINUTES = 45;

/**
 * A position, dropped every ten minutes by the phone in her pocket.
 *
 * Two different things share this endpoint, deliberately. The steady
 * background trail is ours — it answers "where was she" after the fact and
 * nobody else reads it. The family-visible position is only attached to a
 * booking that is running, and only while she has turned sharing on for it.
 *
 * Writing both from one call means the phone has one job and one schedule,
 * rather than a background task that has to know which booking is live.
 */
router.post('/location', wrap(async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const at = new Date();
  const accuracy = Number.isFinite(Number(req.body?.accuracy)) ? Number(req.body.accuracy) : undefined;

  req.nanny.lastLocation = { lat, lng, accuracy, at };
  await req.nanny.save();

  // Which bookings, if any, the family should be seeing this on. A booking
  // that ended an hour ago is not one of them, even if the phone is still
  // sending: the tail is a fixed window, not "until she closes the app".
  const cutoff = new Date(Date.now() - LOCATION_TAIL_MINUTES * 60_000);
  const live = await Booking.find({
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
    'liveLocation.nannySharing': true,
  }).select('serviceDays liveLocation').limit(10);

  const shared = [];
  for (const b of live) {
    const running = (b.serviceDays || []).some((d) => {
      if (d.status === SERVICE_DAY_STATUS.CANCELLED) return false;
      if (!d.startAt || !d.endAt) return false;
      return new Date(d.startAt) <= at && new Date(d.endAt) >= cutoff;
    });
    if (!running) continue;

    b.liveLocation = {
      ...(b.liveLocation?.toObject?.() ?? b.liveLocation ?? {}),
      lastNannyLocation: `${lat},${lng}`,
      updatedAt: at,
    };
    b.markModified('liveLocation');
    await b.save();
    shared.push(b._id);
  }

  return res.json({ ok: true, sharedWithBookings: shared, tailMinutes: LOCATION_TAIL_MINUTES });
}));

/**
 * Turn family-visible sharing on or off for one booking.
 *
 * Separate from the background trail on purpose: she can stop a family seeing
 * where she is without the app losing track of her shift.
 */
router.patch('/bookings/:id/location-sharing', wrap(async (req, res) => {
  const on = req.body?.sharing !== false;
  const b = await Booking.findOne({
    _id: req.params.id,
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
  });
  if (!b) return res.status(404).json({ error: 'Booking not found' });

  b.liveLocation = {
    ...(b.liveLocation?.toObject?.() ?? b.liveLocation ?? {}),
    nannySharing: on,
    ...(on ? {} : { lastNannyLocation: undefined }),
  };
  b.markModified('liveLocation');
  await b.save();

  return res.json({ ok: true, sharing: on });
}));

/**
 * When the phone should be tracking, and until when.
 *
 * The app asks on launch and after each shift rather than working the
 * schedule out itself: the rule about the tail window lives here, with the
 * bookings, and one copy of it is easier to trust than two.
 */
router.get('/location/schedule', wrap(async (req, res) => {
  const now = new Date();
  const soon = new Date(Date.now() + 24 * 3600_000);

  const bookings = await Booking.find({
    $or: [{ nanny: req.nanny._id }, { secondNanny: req.nanny._id }],
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
  }).select('bookingNumber serviceDays liveLocation').lean();

  let trackUntil = null;
  const windows = [];
  for (const b of bookings) {
    for (const d of b.serviceDays || []) {
      if (d.status === SERVICE_DAY_STATUS.CANCELLED || !d.startAt || !d.endAt) continue;
      const ends = new Date(new Date(d.endAt).getTime() + LOCATION_TAIL_MINUTES * 60_000);
      if (ends < now || new Date(d.startAt) > soon) continue;
      windows.push({
        bookingId: b._id,
        bookingNumber: b.bookingNumber,
        startAt: d.startAt,
        endAt: d.endAt,
        stopAt: ends,
        sharing: !!b.liveLocation?.nannySharing,
      });
      if (new Date(d.startAt) <= now && (!trackUntil || ends > trackUntil)) trackUntil = ends;
    }
  }

  windows.sort((a, b2) => new Date(a.startAt) - new Date(b2.startAt));

  return res.json({
    intervalMinutes: 10,
    tailMinutes: LOCATION_TAIL_MINUTES,
    onShiftUntil: trackUntil,
    windows: windows.slice(0, 20),
  });
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
