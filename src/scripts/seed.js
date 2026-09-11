/**
 * Fill an empty database with enough data to work against.
 *
 * `npm run seed` has pointed here since the project began; the file was
 * written late, which is why a wiped database left the dashboard showing
 * nothing at all.
 *
 *   npm run seed                 add what is missing, leave what is there
 *   npm run seed -- --fresh      wipe users and bookings first
 *   npm run seed -- --nannies=50 override the counts
 *
 * Never touches admin accounts, even with --fresh: deleting the login you are
 * about to use would lock you out of the thing being seeded.
 *
 * Media is deliberately shared. Every nanny points at the same handful of
 * files rather than four hundred copies — the point is to see profiles and
 * review queues populated, not to fill a disk. Swapping in different files
 * means changing MEDIA below and nothing else.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import {
  User, Booking, Payment, AdminUser, Session, Note, nextSequence,
} from '../models/index.js';
import {
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS,
  PAYMENT_STATUS,
} from '../utils/constants.js';
import config from '../config/index.js';

/* ------------------------------------------------------------------ *
 * What to make
 * ------------------------------------------------------------------ */

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? parseInt(hit.split('=')[1], 10) : fallback;
};

const FRESH = process.argv.includes('--fresh');
const COUNTS = {
  nannies: arg('nannies', 400),
  families: arg('families', 1000),
  monthsBack: arg('back', 6),
  monthsForward: arg('forward', 3),
};

/** How many of each kind of media each nanny gets. */
const PER_NANNY = { videos: 6, photos: 10, faces: 10, ids: 2 };

/* ------------------------------------------------------------------ *
 * The shared media pool
 * ------------------------------------------------------------------ */

/**
 * Real files from the archive, served by our own /media route.
 *
 * Taken from what is actually on disk rather than invented URLs: a seeded
 * profile whose images 404 tells you nothing about whether the profile screen
 * works, which is the only reason to seed it.
 */
function loadMedia() {
  const dir = config.media.dir;
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    console.warn(`[seed] no media directory at ${dir} — profiles will have no photos.`);
    return { videos: [], photos: [] };
  }

  const url = (f) => `${config.publicBaseUrl}/media/${f}`;
  const videos = files.filter((f) => /\.(mp4|mov|webm)$/i.test(f)).map(url);
  const photos = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map(url);
  return { videos, photos };
}

/** Take n items, repeating the pool when it is smaller than n. */
const take = (pool, n, offset = 0) =>
  (pool.length ? Array.from({ length: n }, (_, i) => pool[(offset + i) % pool.length]) : []);

/* ------------------------------------------------------------------ *
 * Names and details
 * ------------------------------------------------------------------ */

const FIRST_F = ['Maria', 'Sari', 'Dewi', 'Anna', 'Nur', 'Putri', 'Siti', 'Ayu', 'Rina', 'Wulan',
  'Lestari', 'Indah', 'Fitri', 'Yuni', 'Rani', 'Mega', 'Citra', 'Bunga', 'Melati', 'Kartika'];
const LAST = ['Grook', 'Dewi', 'Santoso', 'Wijaya', 'Putra', 'Sari', 'Hidayat', 'Nugroho',
  'Kusuma', 'Pratama', 'Halim', 'Tanaka', 'Suryani', 'Permata', 'Anggraini'];
const FIRST_ANY = ['Ben', 'Camille', 'Priya', 'Tom', 'Yuki', 'Omar', 'Hana', 'Liam', 'Noor', 'Sofia',
  'Daniel', 'Mei', 'Arjun', 'Elena', 'Pieter', 'Aisha', 'Marco', 'Nadia', 'Felix', 'Zara'];

const AREAS = [
  { name: 'Seminyak', lat: -8.69, lng: 115.16 },
  { name: 'Canggu', lat: -8.65, lng: 115.13 },
  { name: 'Ubud', lat: -8.51, lng: 115.26 },
  { name: 'Sanur', lat: -8.69, lng: 115.26 },
  { name: 'Kerobokan', lat: -8.66, lng: 115.17 },
  { name: 'Jimbaran', lat: -8.79, lng: 115.16 },
  { name: 'Uluwatu', lat: -8.83, lng: 115.09 },
  { name: 'Denpasar', lat: -8.67, lng: 115.21 },
];

const LANGS = ['English', 'Arabic', 'French', 'Spanish'];
const SKILLS = ['Cooking', 'Cleaning', 'Newborn Care', 'Tutoring'];
const SUBJECTS = ['English', 'Math', 'Music', 'Art'];
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Deterministic pseudo-randomness.
 *
 * Seeding twice should produce the same people, so a bug found on "nanny 214"
 * is still there when you look again.
 */
let seed = 1337;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const some = (arr, n) => {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i += 1) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

function buildNanny(i, media) {
  const first = FIRST_F[i % FIRST_F.length];
  const last = LAST[(i * 7) % LAST.length];
  const area = AREAS[i % AREAS.length];

  const skills = some(SKILLS, between(1, 3));
  const teaches = skills.includes('Tutoring');

  // A spread of states, so the dashboard's filters all have something in them.
  const roll = rnd();
  const status = roll < 0.82 ? NANNY_STATUS.VERIFIED
    : roll < 0.94 ? NANNY_STATUS.PENDING_VERIFICATION
      : roll < 0.98 ? NANNY_STATUS.SUSPENDED
        : NANNY_STATUS.REJECTED;

  const verified = status === NANNY_STATUS.VERIFIED;

  // Most media approved and a little featured — a review queue with nothing in
  // it is as unhelpful as a profile with nothing on it.
  const mediaItem = (url, j, cap) => ({
    url,
    approved: j < cap,
    approvedAt: j < cap ? new Date() : undefined,
    featured: j < cap && j < 2,
    featuredAt: j < cap && j < 2 ? new Date() : undefined,
    uploadedAt: dayjs().subtract(between(1, 120), 'day').toDate(),
  });

  const videos = take(media.videos, PER_NANNY.videos, i)
    .map((url, j) => ({ ...mediaItem(url, j, 4), title: j === 0 ? 'Introduction' : `Video ${j + 1}` }));

  const photos = take(media.photos, PER_NANNY.photos, i * 3)
    .map((url, j) => ({ ...mediaItem(url, j, 8), caption: `At work ${j + 1}` }));

  const faces = take(media.photos, PER_NANNY.faces, i * 5)
    .map((url, j) => ({
      ...mediaItem(url, j, 8),
      // One face at a time — it is the picture beside her name.
      featured: j === 0,
      featuredAt: j === 0 ? new Date() : undefined,
      caption: `Portrait ${j + 1}`,
    }));

  const idFront = take(media.photos, 1, i * 11)[0];
  const idBack = take(media.photos, 1, i * 11 + 1)[0];
  const cprDoc = take(media.photos, 1, i * 13)[0];
  const cpr = rnd() < 0.6;

  return {
    role: USER_ROLE.NANNY,
    phone: `62811${String(100000 + i).slice(-6)}`,
    fullName: `${first} ${last}`,
    nickname: first,
    email: `${first.toLowerCase()}${i}@example.com`,
    emailVerified: true,
    registrationComplete: true,
    nannyStatus: status,
    backgroundCheckPassed: verified,
    blocked: status === NANNY_STATUS.SUSPENDED,

    age: between(21, 45),
    experienceYears: between(1, 15),
    hourlyRate: [100000, 110000, 120000, 130000, 140000][i % 5],
    cprCertified: cpr,
    ratingAverage: Math.round((3.5 + rnd() * 1.5) * 10) / 10,
    ratingCount: between(0, 40),

    languages: some(LANGS, between(1, 3)).map((name) => ({ name, rating: between(3, 5) })),
    skills: skills.map((name) => ({ name, rating: between(3, 5) })),
    subjects: teaches ? some(SUBJECTS, between(1, 3)) : [],

    residingAddress: `${between(1, 90)} Jl. ${area.name}, Bali`,
    residingMapUrl: `https://maps.google.com/?q=${area.lat},${area.lng}`,

    videos,
    photos,
    profilePictures: faces,
    profilePhotoUrl: faces[0]?.url,
    documents: [
      ...(idFront ? [{ type: 'id_front', url: idFront, verified }] : []),
      ...(idBack ? [{ type: 'id_back', url: idBack, verified }] : []),
      ...(cpr && cprDoc ? [{ type: 'cpr_certificate', url: cprDoc, verified }] : []),
    ],

    availability: {
      days: rnd() < 0.7 ? WEEK : some(WEEK, between(3, 6)),
      startTime: ['06:00', '07:00', '08:00', '09:00'][i % 4],
      maxHoursPerDay: [8, 9, 10, 12, 24][i % 5],
      blockedDates: [],
    },
    createdAt: dayjs().subtract(between(1, 200), 'day').toDate(),
    lastSeenAt: rnd() < 0.8 ? dayjs().subtract(between(0, 40), 'day').toDate() : undefined,
  };
}

function buildFamily(i) {
  const first = FIRST_ANY[i % FIRST_ANY.length];
  const last = LAST[(i * 3) % LAST.length];
  const area = AREAS[(i * 5) % AREAS.length];

  const kids = between(1, 3);
  const children = Array.from({ length: kids }, (_, k) => ({
    name: `${FIRST_ANY[(i + k * 4) % FIRST_ANY.length]}`,
    age: `${between(0, 11)} years`,
    medicalNotes: rnd() < 0.2 ? 'Peanut allergy' : '',
    dietaryNotes: rnd() < 0.15 ? 'Vegetarian' : '',
  }));

  return {
    role: USER_ROLE.FAMILY,
    phone: `62812${String(200000 + i).slice(-6)}`,
    fullName: `${first} ${last}`,
    email: `${first.toLowerCase()}${i}@example.com`,
    emailVerified: true,
    registrationComplete: rnd() < 0.94,
    blocked: rnd() < 0.02,
    addresses: [{
      label: 'Home',
      addressLine: `${between(1, 120)} Jl. ${area.name}, Bali`,
      mapUrl: `https://maps.google.com/?q=${area.lat},${area.lng}`,
      isDefault: true,
    }],
    children,
    createdAt: dayjs().subtract(between(1, 220), 'day').toDate(),
    lastSeenAt: rnd() < 0.75 ? dayjs().subtract(between(0, 60), 'day').toDate() : undefined,
  };
}

/**
 * One booking, dated anywhere in the window and given the status its dates
 * imply — a booking last March cannot be "upcoming".
 */
function buildBooking(i, family, nanny, bookingNumber) {
  const offset = between(-COUNTS.monthsBack * 30, COUNTS.monthsForward * 30);
  const start = dayjs().add(offset, 'day').hour([7, 8, 9, 13, 14][i % 5]).minute(0).second(0).millisecond(0);
  const hours = [3, 4, 5, 6, 8, 12][i % 6];
  const past = offset < 0;
  const today = offset === 0;

  const rate = [120000, 160000, 210000][Math.min(family.children.length, 3) - 1];
  const amount = rate * hours;

  const roll = rnd();
  const status = past
    ? (roll < 0.86 ? BOOKING_STATUS.COMPLETED : BOOKING_STATUS.CANCELLED)
    : today
      ? BOOKING_STATUS.ONGOING
      : (roll < 0.7 ? BOOKING_STATUS.UPCOMING
        : roll < 0.88 ? BOOKING_STATUS.PENDING_PAYMENT
          : BOOKING_STATUS.CANCELLED);

  const paid = status === BOOKING_STATUS.COMPLETED
    || status === BOOKING_STATUS.ONGOING
    || status === BOOKING_STATUS.UPCOMING;

  const dayStatus = status === BOOKING_STATUS.COMPLETED ? SERVICE_DAY_STATUS.COMPLETED
    : status === BOOKING_STATUS.CANCELLED ? SERVICE_DAY_STATUS.CANCELLED
      : status === BOOKING_STATUS.ONGOING ? SERVICE_DAY_STATUS.AWAITING_ARRIVAL
        : SERVICE_DAY_STATUS.SCHEDULED;

  const emergency = !past && rnd() < 0.08;

  return {
    bookingNumber,
    family: family._id,
    nanny: status === BOOKING_STATUS.PENDING_PAYMENT ? undefined : nanny._id,
    status,
    subStatus: paid ? BOOKING_SUBSTATUS.NANNY_CONFIRMED : undefined,
    isMultiDay: false,
    startDate: start.format('YYYY-MM-DD'),
    endDate: start.format('YYYY-MM-DD'),
    startTime: start.format('HH:mm'),
    hoursPerDay: hours,
    serviceDays: [{
      date: start.format('YYYY-MM-DD'),
      startAt: start.toDate(),
      endAt: start.add(hours, 'hour').toDate(),
      hours,
      amount,
      status: dayStatus,
      nanny: nanny._id,
    }],
    address: family.addresses[0],
    requirements: {
      languages: some(LANGS, between(1, 2)),
      skills: some(SKILLS, between(1, 2)),
    },
    children: family.children,
    isEmergency: emergency,
    emergencySurcharge: emergency ? config.emergencySurcharge : 0,
    hourlyRate: rate,
    standardHourlyRate: rate,
    totalAmount: amount,
    paidAmount: paid ? amount : 0,
    paymentStatus: paid ? PAYMENT_STATUS.COMPLETED : PAYMENT_STATUS.IN_PROCESS,
    rating: status === BOOKING_STATUS.COMPLETED && rnd() < 0.6
      ? { stars: between(3, 5), review: 'Great with the children.', ratedAt: start.add(1, 'day').toDate() }
      : undefined,
    completedAt: status === BOOKING_STATUS.COMPLETED ? start.add(hours, 'hour').toDate() : undefined,
    createdAt: start.subtract(between(1, 14), 'day').toDate(),
  };
}

/* ------------------------------------------------------------------ */

async function seedAdmin() {
  const email = (config.admin.email || 'admin@mynanny.com').toLowerCase().trim();
  const existing = await AdminUser.findOne({ email });
  if (existing) { console.log(`admin      : ${email} (already there)`); return existing; }
  const admin = await AdminUser.create({
    email,
    passwordHash: await bcrypt.hash(config.admin.password || 'admin123', 10),
    name: 'Administrator',
    role: 'super_admin',
  });
  console.log(`admin      : ${email} created`);
  return admin;
}

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`[seed] ${config.mongoUri.replace(/\/\/[^@]+@/, '//****@')}\n`);

  const media = loadMedia();
  console.log(`media pool : ${media.videos.length} video(s), ${media.photos.length} photo(s)`);
  if (!media.videos.length || !media.photos.length) {
    console.warn('[seed] the pool is thin — profiles will look emptier than they should.');
  }

  if (FRESH) {
    const [u, b] = await Promise.all([User.countDocuments(), Booking.countDocuments()]);
    console.log(`--fresh    : removing ${u} user(s), ${b} booking(s), payments, notes, sessions\n`);
    await Promise.all([
      User.deleteMany({}), Booking.deleteMany({}), Payment.deleteMany({}),
      Note.deleteMany({}), Session.deleteMany({}),
    ]);
  }

  await seedAdmin();

  // --- nannies ---
  const existingNannies = await User.countDocuments({ role: USER_ROLE.NANNY });
  const nannyDocs = [];
  for (let i = existingNannies; i < COUNTS.nannies; i += 1) nannyDocs.push(buildNanny(i, media));
  if (nannyDocs.length) await User.insertMany(nannyDocs, { ordered: false });
  const nannies = await User.find({ role: USER_ROLE.NANNY }).select('_id').lean();
  console.log(`nannies    : ${nannies.length}`);

  // --- families ---
  const existingFamilies = await User.countDocuments({ role: USER_ROLE.FAMILY });
  const familyDocs = [];
  for (let i = existingFamilies; i < COUNTS.families; i += 1) familyDocs.push(buildFamily(i));
  if (familyDocs.length) await User.insertMany(familyDocs, { ordered: false });
  const families = await User.find({ role: USER_ROLE.FAMILY })
    .select('_id addresses children').lean();
  console.log(`families   : ${families.length}`);

  // --- bookings ---
  const existingBookings = await Booking.countDocuments();
  if (existingBookings > 0) {
    console.log(`bookings   : ${existingBookings} already there, left alone`);
  } else {
    // Roughly two per family across the window, which is what nine months of
    // a working service looks like.
    const total = Math.round(COUNTS.families * 2);
    let next = await nextSequence('booking', 12000);
    const docs = [];
    for (let i = 0; i < total; i += 1) {
      const family = families[i % families.length];
      const nanny = nannies[(i * 13) % nannies.length];
      if (!family?.addresses?.length) continue;
      docs.push(buildBooking(i, family, nanny, String(next + i)));
    }
    // Chunked: one insert of two thousand documents is a long transaction and
    // a bad failure mode if anything in it is rejected.
    for (let i = 0; i < docs.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      await Booking.insertMany(docs.slice(i, i + 500), { ordered: false });
    }
    await nextSequence('booking', next + docs.length);
    console.log(`bookings   : ${docs.length}`);
  }

  const summary = await Booking.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  console.log('\nby status  :');
  summary.sort((a, b) => b.n - a.n).forEach((r) => console.log(`  ${String(r._id).padEnd(20)} ${r.n}`));

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[seed] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
