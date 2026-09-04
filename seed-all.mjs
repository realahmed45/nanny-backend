/**
 * Wipe the database and seed a realistic population.
 *
 *   node seed-all.mjs --yes          # wipe, then seed everything
 *   node seed-all.mjs                # dry run: report what would happen
 *
 * Creates:
 *   150 nannies    verified and bookable
 *   200 families   existing customers, with booking and payment history
 *    20 numbers    said hi and stopped; some part-way through a profile
 *    10 numbers    only ever clicked a referral link
 *
 * Admin accounts are deliberately kept: wiping them locks everyone out of the
 * dashboard, and they are not part of the population being modelled.
 *
 * The wipe is guarded behind --yes because it is not recoverable.
 */
import dotenv from 'dotenv';

dotenv.config();

const CONFIRMED = process.argv.includes('--yes');

const { connectDB, disconnectDB } = await import('./src/config/db.js');
await connectDB();

const {
  User, Booking, Session, ChatThread, Ticket, Otp,
  Counter, MessageLog, CallbackRequest, ReferralClick,
} = await import('./src/models/index.js');
const { Payment, Payout } = await import('./src/models/Payment.js');
const {
  USER_ROLE, NANNY_STATUS, WEEKDAYS, BOOKING_STATUS,
  PAYMENT_STATUS, PAYOUT_STATUS, SERVICE_DAY_STATUS,
} = await import('./src/utils/constants.js');

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 *
 * A fixed seed means re-running produces the same population, so a bug
 * found in one run can be reproduced in the next.
 * ------------------------------------------------------------------ */
let rngState = 20260904;
const rnd = () => {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const sample = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};

const pad = (n, w = 3) => String(n).padStart(w, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
};

/* ------------------------------------------------------------------ *
 * Name and place pools
 * ------------------------------------------------------------------ */

const NANNY_FIRST = [
  'Maria', 'Anna', 'Grace', 'Sophie', 'Fatima', 'Elena', 'Clara', 'Ratna', 'Isabella',
  'Ayu', 'Kadek', 'Wayan', 'Made', 'Nyoman', 'Komang', 'Putu', 'Sari', 'Dewi', 'Indah',
  'Rina', 'Siti', 'Nur', 'Lia', 'Mega', 'Tari', 'Yuni', 'Fitri', 'Lestari', 'Cahaya',
  'Bunga', 'Melati', 'Anggun', 'Citra', 'Diah', 'Eka', 'Gita', 'Hesti', 'Intan', 'Jelita',
  'Kartika', 'Laras', 'Maya', 'Nadia', 'Oktavia', 'Prita', 'Ratih', 'Sinta', 'Tania',
  'Utami', 'Vina', 'Wulan', 'Yanti', 'Zahra', 'Amara', 'Bella', 'Carmen', 'Daniela',
  'Emilia', 'Farah', 'Gloria', 'Hana', 'Ines', 'Julia', 'Katya', 'Lucia', 'Mira',
  'Nina', 'Olga', 'Paula', 'Rosa', 'Sonia', 'Tessa', 'Vera', 'Yara',
];

const NANNY_LAST = [
  'Santos', 'Dewi', 'Putri', 'Wati', 'Sari', 'Lestari', 'Handayani', 'Rahayu',
  'Okonkwo', 'Bennet', 'Chen', 'Al-Rashid', 'Rodriguez', 'Dubois', 'Silva', 'Costa',
  'Nguyen', 'Kumar', 'Suryani', 'Pratiwi', 'Maharani', 'Anggraini', 'Kusuma', 'Wijaya',
  'Hartono', 'Susanto', 'Gunawan', 'Halim', 'Tanaka', 'Reyes', 'Cruz', 'Mendoza',
];

const FAMILY_FIRST = [
  'Ahmed', 'Sarah', 'James', 'Olivia', 'Daniel', 'Emma', 'Michael', 'Sophia', 'David',
  'Isabelle', 'Thomas', 'Charlotte', 'Lucas', 'Amelia', 'Ryan', 'Chloe', 'Adam', 'Zoe',
  'Peter', 'Hannah', 'Mark', 'Laura', 'Simon', 'Nadia', 'Omar', 'Leila', 'Kai', 'Mei',
  'Budi', 'Rizki', 'Andi', 'Dimas', 'Bagus', 'Agus', 'Hendra', 'Yusuf', 'Farhan',
  'Nathan', 'Julia', 'Erik', 'Ingrid', 'Lars', 'Sofia', 'Marco', 'Elena', 'Pablo',
  'Camille', 'Antoine', 'Yuki', 'Haruto', 'Min-ho', 'Ji-woo', 'Arjun', 'Priya',
];

const FAMILY_LAST = [
  'Ali', 'Johnson', 'Smith', 'Brown', 'Wilson', 'Taylor', 'Anderson', 'Martin',
  'Wijaya', 'Santoso', 'Kusuma', 'Hartono', 'Pratama', 'Nugroho', 'Setiawan',
  'Dubois', 'Moreau', 'Rossi', 'Ferrari', 'Muller', 'Schmidt', 'Nielsen', 'Larsen',
  'Tanaka', 'Suzuki', 'Kim', 'Park', 'Sharma', 'Patel', 'Ahmed', 'Hassan', 'Novak',
];

const AREAS = [
  'Seminyak, Bali', 'Canggu, Bali', 'Ubud, Bali', 'Denpasar, Bali', 'Sanur, Bali',
  'Kuta, Bali', 'Jimbaran, Bali', 'Nusa Dua, Bali', 'Uluwatu, Bali', 'Legian, Bali',
  'Berawa, Bali', 'Pererenan, Bali', 'Kerobokan, Bali', 'Tabanan, Bali', 'Gianyar, Bali',
];

const LANGUAGES = ['English', 'Indonesian', 'Balinese', 'Mandarin', 'French', 'Russian', 'Japanese', 'Arabic', 'Spanish', 'German'];
const SKILLS = ['Newborn Care', 'Cooking', 'Cleaning', 'Tutoring', 'Special Needs Care', 'Swimming Supervision', 'Driving'];
const SUBJECTS = ['English', 'Math', 'Science', 'Art', 'Music', 'Reading'];
const CHILD_NAMES = ['Liam', 'Noah', 'Ava', 'Mia', 'Leo', 'Ella', 'Finn', 'Ruby', 'Max', 'Iris', 'Theo', 'Nora', 'Alya', 'Rafi', 'Kiara', 'Bimo'];

const ALL_DAYS = [...WEEKDAYS];
const WEEKDAYS_ONLY = WEEKDAYS.slice(0, 5);

/** Phone blocks, so each cohort can be found and re-seeded independently. */
const PHONE = {
  nanny: '628110',      // + 4 digits
  family: '628120',
  idle: '628130',
  clicker: '628140',
};

const photo = (n) => `https://i.pravatar.cc/300?img=${(n % 70) + 1}`;

/* ------------------------------------------------------------------ *
 * Wipe
 * ------------------------------------------------------------------ */

const COLLECTIONS = [
  ['bookings', Booking], ['payments', Payment], ['payouts', Payout],
  ['users', User], ['sessions', Session], ['chat threads', ChatThread],
  ['tickets', Ticket], ['otps', Otp], ['message logs', MessageLog],
  ['callbacks', CallbackRequest], ['referral clicks', ReferralClick],
  ['counters', Counter],
];

if (!CONFIRMED) {
  console.log('DRY RUN — nothing will be changed. Re-run with --yes to apply.\n');
  console.log('Would delete:');
  for (const [name, Model] of COLLECTIONS) {
    // eslint-disable-next-line no-await-in-loop
    console.log(`  ${String(await Model.countDocuments()).padStart(6)}  ${name}`);
  }
  console.log('\nWould then create:');
  console.log('     150  nannies (verified, bookable)');
  console.log('     200  families (with booking + payment history)');
  console.log('      20  idle numbers (said hi, never booked)');
  console.log('      10  referral-link clicks that never started a chat');
  console.log('\nAdmin accounts are never touched.');
  await disconnectDB();
  process.exit(0);
}

console.log('Wiping...');
for (const [name, Model] of COLLECTIONS) {
  // eslint-disable-next-line no-await-in-loop
  const { deletedCount } = await Model.deleteMany({});
  console.log(`  removed ${String(deletedCount).padStart(6)}  ${name}`);
}

/* ------------------------------------------------------------------ *
 * 150 nannies
 * ------------------------------------------------------------------ */

console.log('\nSeeding nannies...');

const nannyDocs = [];
const usedNicknames = new Set();

for (let i = 0; i < 150; i += 1) {
  const first = NANNY_FIRST[i % NANNY_FIRST.length];
  const last = pick(NANNY_LAST);
  const fullName = `${first} ${last}`;

  // Families only ever see the nickname, so it has to be unique enough to
  // tell two nannies apart in a list.
  let nickname = first;
  let n = 2;
  while (usedNicknames.has(nickname)) { nickname = `${first} ${last[0]}${n === 2 ? '' : n}`; n += 1; }
  usedNicknames.add(nickname);

  const experience = between(1, 15);
  // Rate tracks experience, so the spread looks like a real roster.
  const hourlyRate = 85000 + experience * 4000 + between(-8000, 12000);
  const cpr = chance(0.75);
  const isTutor = chance(0.3);

  const langs = sample(LANGUAGES, between(1, 3));
  const skills = sample(SKILLS, between(2, 4));

  nannyDocs.push({
    role: USER_ROLE.NANNY,
    phone: `${PHONE.nanny}${pad(i + 1, 4)}`,
    fullName,
    nickname,
    email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}${i + 1}@mynanny.test`,
    emailVerified: true,

    age: between(21, 48),
    experienceYears: experience,
    hourlyRate: Math.round(hourlyRate / 1000) * 1000,
    cprCertified: cpr,
    languages: langs.map((name, j) => ({ name, rating: j === 0 ? between(4, 5) : between(3, 5) })),
    skills: skills.map((name) => ({ name, rating: between(3, 5) })),
    subjects: isTutor ? sample(SUBJECTS, between(1, 3)) : [],

    residingAddress: pick(AREAS),
    profilePhotoUrl: photo(i),
    documents: [
      { type: 'id_front', url: `https://cdn.mynanny.test/id/${i}-front.jpg`, verified: true },
      { type: 'id_back', url: `https://cdn.mynanny.test/id/${i}-back.jpg`, verified: true },
      { type: 'profile_photo', url: photo(i), verified: true },
      ...(cpr ? [{ type: 'cpr_certificate', url: `https://cdn.mynanny.test/cpr/${i}.jpg`, verified: true }] : []),
    ],

    availability: {
      days: chance(0.6) ? ALL_DAYS : WEEKDAYS_ONLY,
      startTime: pick(['06:00', '07:00', '08:00', '09:00']),
      maxHoursPerDay: between(6, 12),
      blockedDates: [],
    },

    emergencyContacts: [{
      name: `${pick(NANNY_FIRST)} (family)`,
      phone: `${PHONE.nanny}9${pad(i, 3)}`,
      relation: pick(['Sister', 'Mother', 'Husband', 'Brother']),
    }],

    nannyStatus: NANNY_STATUS.VERIFIED,
    backgroundCheckPassed: true,
    registrationComplete: true,
    blocked: false,

    // A new nanny with no history should look new, not badly rated.
    ratingAverage: experience > 2 ? Number((3.9 + rnd() * 1.1).toFixed(1)) : 0,
    ratingCount: experience > 2 ? between(3, 90) : 0,
    distanceKm: between(1, 15),

    referralCode: `${first.slice(0, 3).toUpperCase()}${2000 + i}`,
  });
}

const nannies = await User.insertMany(nannyDocs);
console.log(`  ${nannies.length} nannies`);

/* ------------------------------------------------------------------ *
 * 200 families
 * ------------------------------------------------------------------ */

console.log('Seeding families...');

const familyDocs = [];
for (let i = 0; i < 200; i += 1) {
  const first = FAMILY_FIRST[i % FAMILY_FIRST.length];
  const last = pick(FAMILY_LAST);
  const area = pick(AREAS);
  const kids = between(1, 3);

  familyDocs.push({
    role: USER_ROLE.FAMILY,
    phone: `${PHONE.family}${pad(i + 1, 4)}`,
    fullName: `${first} ${last}`,
    email: `${first.toLowerCase().replace(/[^a-z]/g, '')}.${last.toLowerCase()}${i + 1}@example.test`,
    emailVerified: true,
    registrationComplete: true,

    addresses: [{
      label: 'Home',
      addressLine: `${between(1, 200)} Jl. ${pick(['Raya', 'Pantai', 'Sunset', 'Batu Belig', 'Petitenget'])}, ${area}`,
      mapUrl: `https://maps.google.com/?q=${encodeURIComponent(area)}`,
      isDefault: true,
    }],

    children: Array.from({ length: kids }, () => ({
      name: pick(CHILD_NAMES),
      age: `${between(1, 11)} years`,
      medicalNotes: chance(0.2) ? pick(['Peanut allergy', 'Asthma — inhaler in the blue bag', 'Lactose intolerant']) : '',
      dietaryNotes: chance(0.25) ? pick(['Vegetarian', 'No pork', 'No nuts']) : '',
    })),

    emergencyContacts: [{
      name: `${pick(FAMILY_FIRST)} ${last}`,
      phone: `${PHONE.family}9${pad(i, 3)}`,
      relation: pick(['Spouse', 'Parent', 'Sibling']),
    }],

    idVerified: chance(0.6),
    referralCode: `${first.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X')}${5000 + i}`,
  });
}

const families = await User.insertMany(familyDocs);
console.log(`  ${families.length} families`);

/* ------------------------------------------------------------------ *
 * Referrals between families
 *
 * Done before bookings, because whether a family had referred someone
 * decides what they were charged.
 * ------------------------------------------------------------------ */

const referrers = sample(families, 45);
for (const referrer of referrers) {
  const count = between(1, 3);
  const invited = sample(families.filter((f) => String(f._id) !== String(referrer._id)), count);
  const firstAt = daysFromNow(-between(5, 120));

  for (const friend of invited) {
    if (friend.referredBy) continue;
    friend.referredBy = referrer._id;
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne({ _id: friend._id }, { referredBy: referrer._id });
    referrer.referralCount = (referrer.referralCount || 0) + 1;
  }

  if (referrer.referralCount) {
    referrer.firstReferralAt = firstAt;
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne(
      { _id: referrer._id },
      { referralCount: referrer.referralCount, firstReferralAt: firstAt },
    );
  }
}
console.log(`  ${referrers.length} families have referred someone`);

/* ------------------------------------------------------------------ *
 * Booking history
 * ------------------------------------------------------------------ */

console.log('Seeding bookings and payments...');

const { hourlyRateFor } = await import('./src/services/pricing.js');
const { generateServiceCode } = await import('./src/services/booking.js');

let bookingSeq = 12345;
const bookings = [];
const payments = [];
const payouts = [];

/** Statuses in the proportions a running marketplace actually shows. */
const STATUS_MIX = [
  ...Array(58).fill(BOOKING_STATUS.COMPLETED),
  ...Array(14).fill(BOOKING_STATUS.UPCOMING),
  ...Array(6).fill(BOOKING_STATUS.ONGOING),
  ...Array(12).fill(BOOKING_STATUS.CANCELLED),
  ...Array(10).fill(BOOKING_STATUS.PENDING_PAYMENT),
];

for (const family of families) {
  const howMany = between(1, 6);

  for (let b = 0; b < howMany; b += 1) {
    const status = pick(STATUS_MIX);
    const nanny = pick(nannies);
    const children = family.children.length || 1;

    // Priced through the real pricing service, so the history is consistent
    // with what the bot would quote today.
    // eslint-disable-next-line no-await-in-loop
    const price = await hourlyRateFor({ user: family, children });

    const multiDay = chance(0.35);
    const hoursPerDay = between(3, 9);

    let startOffset;
    if (status === BOOKING_STATUS.COMPLETED || status === BOOKING_STATUS.CANCELLED) {
      startOffset = -between(7, 240);
    } else if (status === BOOKING_STATUS.ONGOING) {
      startOffset = -between(0, 3);
    } else {
      startOffset = between(2, 70);
    }

    const startDate = daysFromNow(startOffset);
    const dayCount = multiDay ? between(2, 10) : 1;
    const endDate = daysFromNow(startOffset + dayCount - 1);
    const startTime = pick(['07:00', '08:00', '09:00', '13:00', '15:00']);
    const [hh, mm] = startTime.split(':').map(Number);

    const dayAmount = price.hourlyRate * hoursPerDay;
    const serviceDays = Array.from({ length: dayCount }, (_, d) => {
      const date = daysFromNow(startOffset + d);
      const startAt = new Date(date);
      startAt.setHours(hh, mm, 0, 0);
      const endAt = new Date(startAt.getTime() + hoursPerDay * 3600000);

      let dayStatus = SERVICE_DAY_STATUS.SCHEDULED;
      if (status === BOOKING_STATUS.COMPLETED) dayStatus = SERVICE_DAY_STATUS.COMPLETED;
      else if (status === BOOKING_STATUS.CANCELLED) dayStatus = SERVICE_DAY_STATUS.CANCELLED;
      else if (status === BOOKING_STATUS.ONGOING && startAt < new Date()) {
        dayStatus = SERVICE_DAY_STATUS.COMPLETED;
      }

      return {
        date: iso(date),
        startAt,
        endAt,
        hours: hoursPerDay,
        amount: dayAmount,
        status: dayStatus,
        arrivalOtp: generateServiceCode(),
        endOtp: generateServiceCode(),
      };
    });

    const totalAmount = dayAmount * dayCount;
    bookingSeq += 1;
    const bookingNumber = String(bookingSeq);

    let paymentStatus = PAYMENT_STATUS.COMPLETED;
    if (status === BOOKING_STATUS.PENDING_PAYMENT) paymentStatus = PAYMENT_STATUS.IN_PROCESS;
    else if (status === BOOKING_STATUS.CANCELLED) {
      paymentStatus = chance(0.7) ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.COMPLETED;
    }

    const createdAt = daysFromNow(startOffset - between(2, 20));

    const booking = {
      bookingNumber,
      family: family._id,
      nanny: nanny._id,
      status,
      isMultiDay: dayCount > 1,
      startDate: iso(startDate),
      endDate: iso(endDate),
      startTime,
      hoursPerDay,
      repeatDays: [],
      serviceDays,
      address: {
        label: 'Home',
        addressLine: family.addresses[0]?.addressLine,
        mapUrl: family.addresses[0]?.mapUrl,
      },
      requirements: {
        languages: sample(LANGUAGES, between(1, 2)),
        skills: sample(SKILLS, between(1, 2)),
        subjects: [],
      },
      children: family.children.map((c) => ({
        name: c.name, age: c.age, medicalNotes: c.medicalNotes, dietaryNotes: c.dietaryNotes,
      })),
      isEmergency: chance(0.08),
      hourlyRate: price.hourlyRate,
      totalAmount,
      standardHourlyRate: price.standardRate,
      referralDiscountApplied: price.discounted,
      paidAmount: paymentStatus === PAYMENT_STATUS.COMPLETED || paymentStatus === PAYMENT_STATUS.REFUNDED
        ? totalAmount : 0,
      paymentStatus,
      createdAt,
      updatedAt: createdAt,
    };

    if (status === BOOKING_STATUS.CANCELLED) {
      booking.cancelledAt = daysFromNow(startOffset - between(0, 3));
      booking.cancellationReason = pick(['Change of plans', 'Travelling', 'Found other care', 'Child unwell']);
    }
    if (status === BOOKING_STATUS.COMPLETED && chance(0.7)) {
      booking.familyRating = between(4, 5);
    }

    bookings.push(booking);
  }
}

const createdBookings = await Booking.insertMany(bookings);
console.log(`  ${createdBookings.length} bookings`);

// Payments and payouts follow the bookings they belong to.
for (const b of createdBookings) {
  if (b.paymentStatus === PAYMENT_STATUS.IN_PROCESS) {
    payments.push({
      family: b.family, booking: b._id, kind: 'booking', amount: b.totalAmount,
      status: PAYMENT_STATUS.IN_PROCESS,
      reference: `TRF${b.bookingNumber}`,
      proof: {
        url: `https://cdn.mynanny.test/proofs/${b.bookingNumber}.jpg`,
        uploadedAt: b.createdAt,
      },
      createdAt: b.createdAt,
    });
    continue;
  }

  payments.push({
    family: b.family, booking: b._id, kind: 'booking', amount: b.totalAmount,
    status: PAYMENT_STATUS.COMPLETED,
    reference: `TRF${b.bookingNumber}`,
    proof: {
      url: `https://cdn.mynanny.test/proofs/${b.bookingNumber}.jpg`,
      uploadedAt: b.createdAt,
    },
    createdAt: b.createdAt,
  });

  if (b.paymentStatus === PAYMENT_STATUS.REFUNDED) {
    payments.push({
      family: b.family, booking: b._id, kind: 'refund',
      amount: Math.round(b.totalAmount * (chance(0.5) ? 1 : 0.5)),
      status: PAYMENT_STATUS.REFUNDED,
      reference: `RFD${b.bookingNumber}`,
      createdAt: b.cancelledAt || b.createdAt,
    });
  }

  // A completed booking means the nanny is owed for the days she worked.
  if (b.status === BOOKING_STATUS.COMPLETED) {
    const worked = (b.serviceDays || []).filter((d) => d.status === SERVICE_DAY_STATUS.COMPLETED);
    if (worked.length) {
      const paid = chance(0.8);
      payouts.push({
        reference: `PYT${b.bookingNumber}`,
        nanny: b.nanny, booking: b._id,
        amount: Math.round(b.totalAmount * 0.75),
        status: paid ? PAYOUT_STATUS.COMPLETED : PAYOUT_STATUS.PENDING,
        releasedAt: paid ? b.updatedAt : undefined,
        isFinalForBooking: true,
        createdAt: b.updatedAt,
      });
    }
  }
}

await Payment.insertMany(payments);
await Payout.insertMany(payouts);
console.log(`  ${payments.length} payments, ${payouts.length} payouts`);

/* ------------------------------------------------------------------ *
 * 20 idle numbers
 *
 * People who messaged once and went quiet. Some got part-way through a
 * profile. They are the funnel's biggest leak, so they need to be visible.
 * ------------------------------------------------------------------ */

console.log('Seeding idle numbers...');

const idleUsers = [];
const idleSessions = [];
const idleLogs = [];

for (let i = 0; i < 20; i += 1) {
  const phone = `${PHONE.idle}${pad(i + 1, 4)}`;
  const first = pick(FAMILY_FIRST);
  const lastSeen = daysFromNow(-between(1, 90));

  // Three kinds of drop-off: never said more than hi, gave a name, or got
  // as far as an unverified email.
  const depth = i % 3;

  if (depth > 0) {
    idleUsers.push({
      role: USER_ROLE.FAMILY,
      phone,
      fullName: `${first} ${pick(FAMILY_LAST)}`,
      email: depth === 2 ? `${first.toLowerCase()}.dropped${i}@example.test` : undefined,
      emailVerified: false,
      registrationComplete: false,
      createdAt: lastSeen,
    });
  }

  idleSessions.push({
    phone,
    state: depth === 0 ? 'ROLE_PICK' : depth === 1 ? 'FAMILY_REG_EMAIL' : 'FAMILY_REG_OTP',
    role: depth === 0 ? undefined : USER_ROLE.FAMILY,
    data: depth > 0 ? { fullName: `${first} ${pick(FAMILY_LAST)}` } : {},
    updatedAt: lastSeen,
    createdAt: lastSeen,
  });

  const greeting = pick(['nanny', 'Nanny', 'hi', 'hello', 'nanny hi']);
  idleLogs.push({
    phone, direction: 'in', body: greeting, createdAt: lastSeen,
  });
  idleLogs.push({
    phone, direction: 'out',
    body: greeting.toLowerCase().includes('nanny')
      ? 'Welcome to My Nanny! Are you looking to hire a nanny, or to work as one?'
      : 'Send *nanny* to get started.',
    createdAt: new Date(lastSeen.getTime() + 2000),
  });
}

if (idleUsers.length) await User.insertMany(idleUsers);
await Session.insertMany(idleSessions);
await MessageLog.insertMany(idleLogs).catch(() => {});
console.log(`  20 idle numbers (${idleUsers.length} with a partial profile)`);

/* ------------------------------------------------------------------ *
 * 10 referral clicks that never became a chat
 * ------------------------------------------------------------------ */

console.log('Seeding referral clicks...');

const clickReferrers = sample(referrers, 10);
const clicks = clickReferrers.map((r, i) => ({
  code: r.referralCode,
  referrer: r._id,
  convertedTo: null,
  convertedAt: null,
  userAgent: pick([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  ]),
  ip: `103.${between(1, 254)}.${between(1, 254)}.${between(1, 254)}`,
  createdAt: daysFromNow(-between(1, 60)),
}));

await ReferralClick.insertMany(clicks);
console.log(`  ${clicks.length} referral link clicks, none converted`);

/* ------------------------------------------------------------------ *
 * Keep the booking counter ahead of the seeded numbers, so the next real
 * booking does not collide with one of these.
 * ------------------------------------------------------------------ */

await Counter.findOneAndUpdate(
  { _id: 'booking' },
  { _id: 'booking', seq: bookingSeq + 1 },
  { upsert: true },
);

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const discounted = createdBookings.filter((b) => b.referralDiscountApplied).length;

console.log('\nDone.');
console.log(`  nannies            ${await User.countDocuments({ role: USER_ROLE.NANNY })}`);
console.log(`  families           ${await User.countDocuments({ role: USER_ROLE.FAMILY, registrationComplete: true })}`);
console.log(`  incomplete signups ${await User.countDocuments({ registrationComplete: false })}`);
console.log(`  sessions           ${await Session.countDocuments()}`);
console.log(`  bookings           ${await Booking.countDocuments()}`);
console.log(`    at referred rate ${discounted}`);
console.log(`  payments           ${await Payment.countDocuments()}`);
console.log(`  payouts            ${await Payout.countDocuments()}`);
console.log(`  referral clicks    ${await ReferralClick.countDocuments()}`);
console.log('\nAdmin accounts were not touched — log in as before.');

await disconnectDB();
process.exit(0);
