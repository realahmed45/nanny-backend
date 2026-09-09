/**
 * Put a usable amount of data into an empty database.
 *
 * `npm run seed` has pointed at this file since the project began, but the
 * file was never written — so a fresh or wiped database left the dashboard
 * showing nothing and nothing to click on.
 *
 * What it makes: the admin account, a handful of verified nannies with real
 * availability, some families, and bookings spread across the states the
 * dashboard has screens for — upcoming, ongoing, completed, awaiting payment.
 * Enough to see whether a change works, not a synthetic customer base.
 *
 *   npm run seed            add anything missing, leave what is there
 *   npm run seed -- --fresh wipe users and bookings first, then seed
 *
 * Never touches a database that already has real traffic unless you ask for
 * --fresh: a seed that quietly overwrote production would be worse than no
 * seed at all.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import {
  User, Booking, AdminUser, Session, nextSequence,
} from '../models/index.js';
import {
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS,
  PAYMENT_STATUS,
} from '../utils/constants.js';
import config from '../config/index.js';

const fresh = process.argv.includes('--fresh');

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ------------------------------------------------------------------ *
 * The people
 * ------------------------------------------------------------------ */

const NANNIES = [
  {
    phone: '6281100001', fullName: 'Maria Grook', nickname: 'Maria', age: 28,
    experienceYears: 6, hourlyRate: 120000, cprCertified: true, ratingAverage: 4.9,
    languages: [{ name: 'English', rating: 5 }, { name: 'Arabic', rating: 4 }],
    skills: [{ name: 'Newborn Care', rating: 5 }, { name: 'Cooking', rating: 4 }],
    availability: { days: WEEK, startTime: '07:00', maxHoursPerDay: 12, blockedDates: [] },
  },
  {
    phone: '6281100002', fullName: 'Sari Dewi', nickname: 'Sari', age: 24,
    experienceYears: 3, hourlyRate: 110000, cprCertified: true, ratingAverage: 4.7,
    languages: [{ name: 'English', rating: 4 }],
    skills: [{ name: 'Cooking', rating: 5 }, { name: 'Cleaning', rating: 4 }],
    availability: { days: WEEK.slice(0, 5), startTime: '08:00', maxHoursPerDay: 9, blockedDates: [] },
  },
  {
    phone: '6281100003', fullName: 'Anna Tanaka', nickname: 'Anna', age: 31,
    experienceYears: 9, hourlyRate: 140000, cprCertified: true, ratingAverage: 5,
    languages: [{ name: 'English', rating: 5 }, { name: 'Spanish', rating: 3 }],
    skills: [{ name: 'Tutoring', rating: 5 }, { name: 'Newborn Care', rating: 4 }],
    subjects: ['English', 'Math'],
    availability: { days: WEEK, startTime: '06:00', maxHoursPerDay: 24, blockedDates: [] },
  },
  {
    phone: '6281100004', fullName: 'Nur Aisyah', nickname: 'Nur', age: 26,
    experienceYears: 4, hourlyRate: 115000, cprCertified: false, ratingAverage: 4.4,
    languages: [{ name: 'English', rating: 4 }],
    skills: [{ name: 'Cleaning', rating: 5 }, { name: 'Cooking', rating: 3 }],
    availability: { days: WEEK, startTime: '09:00', maxHoursPerDay: 8, blockedDates: [] },
  },
  {
    // One still waiting, so the verification queue is not empty.
    phone: '6281100005', fullName: 'Putri Lestari', nickname: 'Putri', age: 22,
    experienceYears: 1, hourlyRate: 100000, cprCertified: false,
    status: NANNY_STATUS.PENDING_VERIFICATION,
    languages: [{ name: 'English', rating: 3 }],
    skills: [{ name: 'Cleaning', rating: 4 }],
    availability: { days: WEEK.slice(0, 5), startTime: '08:00', maxHoursPerDay: 8, blockedDates: [] },
  },
];

const FAMILIES = [
  {
    phone: '6281200001', fullName: 'Ben Carter', email: 'ben@example.com',
    address: { label: 'Home', addressLine: '12 Jl. Kayu Aya, Seminyak', mapUrl: 'https://maps.google.com/?q=-8.68,115.16' },
    children: [{ name: 'Emma', age: '4 years', medicalNotes: 'Peanut allergy', dietaryNotes: 'Vegetarian' }],
  },
  {
    phone: '6281200002', fullName: 'Camille Nielsen', email: 'camille@example.com',
    address: { label: 'Villa', addressLine: '11 Jl. Petitenget, Kerobokan', mapUrl: 'https://maps.google.com/?q=-8.67,115.15' },
    children: [{ name: 'Noah', age: '2 years' }, { name: 'Ava', age: '5 years' }],
  },
  {
    phone: '6281200003', fullName: 'Priya Anand', email: 'priya@example.com',
    address: { label: 'Home', addressLine: '4 Jl. Pantai Berawa, Canggu', mapUrl: 'https://maps.google.com/?q=-8.66,115.13' },
    children: [{ name: 'Kiran', age: '7 years' }],
  },
];

/* ------------------------------------------------------------------ *
 * Bookings, described by what they should look like on screen
 * ------------------------------------------------------------------ */

const BOOKINGS = [
  { family: 0, nanny: 0, daysFromNow: 3, hours: 4, status: BOOKING_STATUS.UPCOMING, paid: true },
  { family: 1, nanny: 2, daysFromNow: 5, hours: 8, status: BOOKING_STATUS.UPCOMING, paid: true },
  { family: 2, nanny: 1, daysFromNow: 0, hours: 6, status: BOOKING_STATUS.ONGOING, paid: true },
  { family: 0, nanny: 3, daysFromNow: -7, hours: 5, status: BOOKING_STATUS.COMPLETED, paid: true },
  { family: 1, nanny: 0, daysFromNow: -14, hours: 4, status: BOOKING_STATUS.COMPLETED, paid: true },
  { family: 2, nanny: null, daysFromNow: 2, hours: 4, status: BOOKING_STATUS.PENDING_PAYMENT, paid: false },
  // Same-day and urgent, so the emergency screens have something in them.
  {
    family: 0, nanny: null, daysFromNow: 0, hours: 3,
    status: BOOKING_STATUS.PENDING_PAYMENT, paid: false, emergency: true,
  },
];

/* ------------------------------------------------------------------ */

async function seedAdmin() {
  const email = (config.admin.email || 'admin@mynanny.com').toLowerCase().trim();
  const password = config.admin.password || 'admin123';

  const existing = await AdminUser.findOne({ email });
  if (existing) {
    console.log(`admin      : ${email} (already there, left alone)`);
    return existing;
  }
  const admin = await AdminUser.create({
    email,
    passwordHash: await bcrypt.hash(password, 10),
    name: 'Administrator',
    role: 'super_admin',
  });
  console.log(`admin      : ${email} created (password: ${password})`);
  return admin;
}

async function seedNannies() {
  const made = [];
  for (const n of NANNIES) {
    // eslint-disable-next-line no-await-in-loop
    let nanny = await User.findOne({ phone: n.phone, role: USER_ROLE.NANNY });
    if (!nanny) {
      // eslint-disable-next-line no-await-in-loop
      nanny = await User.create({
        ...n,
        role: USER_ROLE.NANNY,
        email: `${n.nickname.toLowerCase()}@example.com`,
        emailVerified: true,
        registrationComplete: true,
        nannyStatus: n.status || NANNY_STATUS.VERIFIED,
        backgroundCheckPassed: (n.status || NANNY_STATUS.VERIFIED) === NANNY_STATUS.VERIFIED,
        residingAddress: 'Denpasar, Bali',
      });
    }
    made.push(nanny);
  }
  console.log(`nannies    : ${made.length}`);
  return made;
}

async function seedFamilies() {
  const made = [];
  for (const f of FAMILIES) {
    // eslint-disable-next-line no-await-in-loop
    let family = await User.findOne({ phone: f.phone, role: USER_ROLE.FAMILY });
    if (!family) {
      // eslint-disable-next-line no-await-in-loop
      family = await User.create({
        phone: f.phone,
        fullName: f.fullName,
        email: f.email,
        emailVerified: true,
        role: USER_ROLE.FAMILY,
        registrationComplete: true,
        addresses: [{ ...f.address, isDefault: true }],
        children: f.children,
      });
    }
    made.push(family);
  }
  console.log(`families   : ${made.length}`);
  return made;
}

/** One booking, with its service days priced and dated like the real thing. */
async function seedBooking(spec, families, nannies) {
  const family = families[spec.family];
  const nanny = spec.nanny === null ? null : nannies[spec.nanny];

  const start = dayjs().add(spec.daysFromNow, 'day').hour(9).minute(0).second(0);
  const rate = nanny?.hourlyRate || 120000;
  const amount = rate * spec.hours;

  const dayStatus = spec.status === BOOKING_STATUS.COMPLETED
    ? SERVICE_DAY_STATUS.COMPLETED
    : spec.status === BOOKING_STATUS.ONGOING
      ? SERVICE_DAY_STATUS.AWAITING_ARRIVAL
      : SERVICE_DAY_STATUS.SCHEDULED;

  return Booking.create({
    bookingNumber: String(await nextSequence('booking', 12000)),
    family: family._id,
    nanny: nanny?._id,
    status: spec.status,
    subStatus: nanny ? BOOKING_SUBSTATUS.NANNY_CONFIRMED : undefined,
    isMultiDay: false,
    startDate: start.format('YYYY-MM-DD'),
    endDate: start.format('YYYY-MM-DD'),
    startTime: '09:00',
    hoursPerDay: spec.hours,
    serviceDays: [{
      date: start.format('YYYY-MM-DD'),
      startAt: start.toDate(),
      endAt: start.add(spec.hours, 'hour').toDate(),
      hours: spec.hours,
      amount,
      status: dayStatus,
      nanny: nanny?._id,
    }],
    address: family.addresses[0],
    requirements: { languages: ['English'], skills: ['Cooking'] },
    children: family.children,
    isEmergency: !!spec.emergency,
    emergencySurcharge: spec.emergency ? config.emergencySurcharge : 0,
    hourlyRate: rate,
    standardHourlyRate: rate,
    totalAmount: amount,
    paidAmount: spec.paid ? amount : 0,
    paymentStatus: spec.paid ? PAYMENT_STATUS.COMPLETED : PAYMENT_STATUS.IN_PROCESS,
    completedAt: spec.status === BOOKING_STATUS.COMPLETED ? start.toDate() : undefined,
  });
}

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`[seed] ${config.mongoUri.replace(/\/\/[^@]+@/, '//****@')}\n`);

  if (fresh) {
    // Deliberately loud, and deliberately not including admins: wiping the
    // account you sign in with would lock you out of the thing you are seeding.
    const [users, bookings] = await Promise.all([
      User.countDocuments(), Booking.countDocuments(),
    ]);
    console.log(`--fresh: deleting ${users} user(s), ${bookings} booking(s), and all sessions\n`);
    await Promise.all([
      User.deleteMany({}), Booking.deleteMany({}), Session.deleteMany({}),
    ]);
  }

  await seedAdmin();
  const nannies = await seedNannies();
  const families = await seedFamilies();

  // Only when there is nothing already, so a re-run does not pile up copies.
  const existingBookings = await Booking.countDocuments();
  if (existingBookings === 0) {
    for (const spec of BOOKINGS) {
      // eslint-disable-next-line no-await-in-loop
      await seedBooking(spec, families, nannies);
    }
    console.log(`bookings   : ${BOOKINGS.length}`);
  } else {
    console.log(`bookings   : ${existingBookings} already there, left alone`);
  }

  console.log('\nDone. Sign in with the admin email and password above.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[seed] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
