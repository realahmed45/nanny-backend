/**
 * Seed 20 fully-populated nannies.
 *
 * Every nanny is written so she is genuinely bookable: verified, background
 * checked, registrationComplete, with availability that the matching service
 * can satisfy. Anything less and she exists in the dashboard but never appears
 * in a search, which is the failure mode worth avoiding here.
 *
 *   node seed-nannies.mjs            # add the 20 (skips any that exist)
 *   node seed-nannies.mjs --replace  # delete these 20 first, then re-add
 *
 * Only touches the seeded phone range, so real nannies are never removed.
 */
import dotenv from 'dotenv';

dotenv.config();

const { connectDB, disconnectDB } = await import('./src/config/db.js');
await connectDB();

const { User } = await import('./src/models/index.js');
const { USER_ROLE, NANNY_STATUS, WEEKDAYS } = await import('./src/utils/constants.js');

const REPLACE = process.argv.includes('--replace');

/** A recognisable block so the seed can be re-run or cleaned up safely. */
const PHONE_PREFIX = '9715559';

const ALL_DAYS = [...WEEKDAYS];
const WEEKDAYS_ONLY = WEEKDAYS.slice(0, 5);
const WEEKEND = ['Saturday', 'Sunday'];

/** Deterministic placeholder image, so every profile has a photo. */
const photo = (seed) => `https://i.pravatar.cc/300?img=${seed}`;
const docs = (seed) => [
  { type: 'id_front', url: `https://cdn.mynanny.test/id/${seed}-front.jpg`, verified: true },
  { type: 'id_back', url: `https://cdn.mynanny.test/id/${seed}-back.jpg`, verified: true },
  { type: 'profile_photo', url: photo(seed), verified: true },
];

const NANNIES = [
  {
    fullName: 'Maria Grook', age: 32, experienceYears: 8, hourlyRate: 125000, cpr: true,
    rating: 4.9, ratings: 47, distanceKm: 2,
    languages: [['English', 5], ['Arabic', 4]],
    skills: [['Newborn Care', 5], ['Cooking', 4]],
    area: 'Seminyak, Bali', days: ALL_DAYS, start: '07:00', maxHours: 10,
  },
  {
    fullName: 'Anna Bennet', age: 28, experienceYears: 5, hourlyRate: 110000, cpr: true,
    rating: 4.7, ratings: 31, distanceKm: 4,
    languages: [['English', 5], ['French', 3]],
    skills: [['Cooking', 5], ['Cleaning', 4]],
    area: 'Canggu, Bali', days: WEEKDAYS_ONLY, start: '08:00', maxHours: 8,
  },
  {
    fullName: 'Grace Okonkwo', age: 35, experienceYears: 12, hourlyRate: 150000, cpr: true,
    rating: 5.0, ratings: 89, distanceKm: 3,
    languages: [['English', 5]],
    skills: [['Newborn Care', 5], ['Cooking', 4], ['Cleaning', 4]],
    area: 'Ubud, Bali', days: ALL_DAYS, start: '06:00', maxHours: 12,
  },
  {
    fullName: 'Sophie Chen', age: 26, experienceYears: 3, hourlyRate: 100000, cpr: true,
    rating: 4.5, ratings: 18, distanceKm: 5,
    languages: [['English', 4], ['Spanish', 3]],
    skills: [['Tutoring', 5], ['Cooking', 3]],
    subjects: ['English', 'Math'],
    area: 'Denpasar, Bali', days: WEEKDAYS_ONLY, start: '13:00', maxHours: 6,
  },
  {
    fullName: 'Fatima Al-Rashid', age: 30, experienceYears: 7, hourlyRate: 130000, cpr: true,
    rating: 4.8, ratings: 42, distanceKm: 2,
    languages: [['Arabic', 5], ['English', 4]],
    skills: [['Newborn Care', 5], ['Cleaning', 4]],
    area: 'Sanur, Bali', days: ALL_DAYS, start: '07:00', maxHours: 10,
  },
  {
    fullName: 'Elena Rodriguez', age: 29, experienceYears: 6, hourlyRate: 120000, cpr: true,
    rating: 4.6, ratings: 27, distanceKm: 6,
    languages: [['Spanish', 5], ['English', 4]],
    skills: [['Cooking', 5], ['Tutoring', 4]],
    subjects: ['Art', 'Music'],
    area: 'Kuta, Bali', days: WEEKDAYS_ONLY, start: '09:00', maxHours: 8,
  },
  {
    fullName: 'Priya Sharma', age: 27, experienceYears: 4, hourlyRate: 105000, cpr: false,
    rating: 4.4, ratings: 15, distanceKm: 7,
    languages: [['English', 5]],
    skills: [['Tutoring', 5], ['Cleaning', 3]],
    subjects: ['Math', 'All Homework'],
    area: 'Jimbaran, Bali', days: WEEKDAYS_ONLY, start: '14:00', maxHours: 6,
  },
  {
    fullName: 'Aisha Nasser', age: 33, experienceYears: 9, hourlyRate: 140000, cpr: true,
    rating: 4.9, ratings: 56, distanceKm: 3,
    languages: [['Arabic', 5], ['English', 5], ['French', 3]],
    skills: [['Newborn Care', 5], ['Cooking', 5]],
    area: 'Seminyak, Bali', days: ALL_DAYS, start: '06:00', maxHours: 12,
  },
  {
    fullName: 'Clara Dubois', age: 31, experienceYears: 7, hourlyRate: 135000, cpr: true,
    rating: 4.7, ratings: 38, distanceKm: 4,
    languages: [['French', 5], ['English', 4]],
    skills: [['Tutoring', 5], ['Cooking', 4]],
    subjects: ['English', 'Art'],
    area: 'Ubud, Bali', days: WEEKDAYS_ONLY, start: '08:00', maxHours: 9,
  },
  {
    fullName: 'Ratna Dewi', age: 34, experienceYears: 11, hourlyRate: 115000, cpr: true,
    rating: 4.8, ratings: 64, distanceKm: 1,
    languages: [['English', 4]],
    skills: [['Newborn Care', 5], ['Cooking', 5], ['Cleaning', 5]],
    area: 'Denpasar, Bali', days: ALL_DAYS, start: '07:00', maxHours: 10,
  },
  {
    fullName: 'Isabella Santos', age: 25, experienceYears: 3, hourlyRate: 95000, cpr: false,
    rating: 4.3, ratings: 12, distanceKm: 8,
    languages: [['Spanish', 5], ['English', 3]],
    skills: [['Cleaning', 4], ['Cooking', 3]],
    area: 'Canggu, Bali', days: WEEKEND, start: '08:00', maxHours: 8,
  },
  {
    fullName: 'Nadia Karim', age: 29, experienceYears: 6, hourlyRate: 125000, cpr: true,
    rating: 4.6, ratings: 33, distanceKm: 5,
    languages: [['Arabic', 5], ['English', 4]],
    skills: [['Newborn Care', 4], ['Tutoring', 4]],
    subjects: ['Math', 'English'],
    area: 'Sanur, Bali', days: WEEKDAYS_ONLY, start: '09:00', maxHours: 8,
  },
  {
    fullName: 'Wayan Sari', age: 36, experienceYears: 14, hourlyRate: 145000, cpr: true,
    rating: 5.0, ratings: 102, distanceKm: 2,
    languages: [['English', 4]],
    skills: [['Newborn Care', 5], ['Cooking', 5]],
    area: 'Ubud, Bali', days: ALL_DAYS, start: '06:00', maxHours: 12,
  },
  {
    fullName: 'Julia Moreau', age: 28, experienceYears: 5, hourlyRate: 120000, cpr: true,
    rating: 4.5, ratings: 22, distanceKm: 6,
    languages: [['French', 5], ['English', 4], ['Spanish', 3]],
    skills: [['Cooking', 4], ['Cleaning', 4]],
    area: 'Kuta, Bali', days: WEEKDAYS_ONLY, start: '10:00', maxHours: 7,
  },
  {
    fullName: 'Amara Okafor', age: 31, experienceYears: 8, hourlyRate: 130000, cpr: true,
    rating: 4.8, ratings: 45, distanceKm: 3,
    languages: [['English', 5]],
    skills: [['Newborn Care', 5], ['Tutoring', 4], ['Cooking', 4]],
    subjects: ['All Homework', 'Math'],
    area: 'Seminyak, Bali', days: ALL_DAYS, start: '07:00', maxHours: 10,
  },
  {
    fullName: 'Kadek Ayu', age: 24, experienceYears: 2, hourlyRate: 90000, cpr: false,
    rating: 4.2, ratings: 8, distanceKm: 4,
    languages: [['English', 4]],
    skills: [['Cleaning', 4], ['Cooking', 3]],
    area: 'Denpasar, Bali', days: WEEKDAYS_ONLY, start: '08:00', maxHours: 6,
  },
  {
    fullName: 'Layla Hassan', age: 32, experienceYears: 9, hourlyRate: 135000, cpr: true,
    rating: 4.9, ratings: 51, distanceKm: 2,
    languages: [['Arabic', 5], ['English', 5]],
    skills: [['Newborn Care', 5], ['Cleaning', 4], ['Cooking', 4]],
    area: 'Jimbaran, Bali', days: ALL_DAYS, start: '06:00', maxHours: 11,
  },
  {
    fullName: 'Emma Wilson', age: 27, experienceYears: 4, hourlyRate: 110000, cpr: true,
    rating: 4.4, ratings: 19, distanceKm: 7,
    languages: [['English', 5]],
    skills: [['Tutoring', 5]],
    subjects: ['English', 'Music', 'Art'],
    area: 'Canggu, Bali', days: WEEKDAYS_ONLY, start: '13:00', maxHours: 5,
  },
  {
    fullName: 'Made Puspita', age: 38, experienceYears: 16, hourlyRate: 155000, cpr: true,
    rating: 5.0, ratings: 118, distanceKm: 1,
    languages: [['English', 4]],
    skills: [['Newborn Care', 5], ['Cooking', 5], ['Cleaning', 5], ['Tutoring', 3]],
    subjects: ['All Homework'],
    area: 'Ubud, Bali', days: ALL_DAYS, start: '06:00', maxHours: 12,
  },
  {
    fullName: 'Zara Ahmed', age: 26, experienceYears: 3, hourlyRate: 100000, cpr: true,
    rating: 4.5, ratings: 16, distanceKm: 5,
    languages: [['Arabic', 4], ['English', 4]],
    skills: [['Cooking', 4], ['Newborn Care', 3]],
    area: 'Sanur, Bali', days: WEEKEND, start: '07:00', maxHours: 9,
  },
];

/** Turn one spec into the shape the User model expects. */
function toDoc(spec, i) {
  const seed = i + 1;
  const first = spec.fullName.split(' ')[0].toLowerCase();

  return {
    role: USER_ROLE.NANNY,
    phone: `${PHONE_PREFIX}${String(i + 1).padStart(3, '0')}`,
    fullName: spec.fullName,
    email: `${first}.nanny${seed}@mynanny.test`,
    emailVerified: true,

    age: spec.age,
    experienceYears: spec.experienceYears,
    hourlyRate: spec.hourlyRate,
    cprCertified: spec.cpr,
    languages: spec.languages.map(([name, rating]) => ({ name, rating })),
    skills: spec.skills.map(([name, rating]) => ({ name, rating })),
    subjects: spec.subjects || [],

    residingAddress: spec.area,
    residingMapUrl: `https://maps.google.com/?q=${encodeURIComponent(spec.area)}`,
    profilePhotoUrl: photo(seed),
    documents: spec.cpr
      ? [...docs(seed), { type: 'cpr_certificate', url: `https://cdn.mynanny.test/cpr/${seed}.jpg`, verified: true }]
      : docs(seed),

    availability: {
      days: spec.days,
      startTime: spec.start,
      maxHoursPerDay: spec.maxHours,
      blockedDates: [],
    },

    emergencyContacts: [
      { name: `${spec.fullName.split(' ')[1] || 'Contact'} (family)`, phone: `${PHONE_PREFIX}9${String(i + 1).padStart(2, '0')}`, relation: 'Family' },
    ],

    // Everything the matching service requires to return her in a search.
    nannyStatus: NANNY_STATUS.VERIFIED,
    backgroundCheckPassed: true,
    registrationComplete: true,
    blocked: false,

    ratingAverage: spec.rating,
    ratingCount: spec.ratings,
    distanceKm: spec.distanceKm,

    referralCode: `${spec.fullName.split(' ')[0].slice(0, 3).toUpperCase()}${1000 + i}`,
  };
}

const docsToInsert = NANNIES.map(toDoc);
const phones = docsToInsert.map((d) => d.phone);

if (REPLACE) {
  const { deletedCount } = await User.deleteMany({ role: USER_ROLE.NANNY, phone: { $in: phones } });
  console.log(`Removed ${deletedCount} previously seeded nannies.`);
}

let created = 0;
let skipped = 0;

for (const doc of docsToInsert) {
  // eslint-disable-next-line no-await-in-loop
  const exists = await User.findOne({ role: USER_ROLE.NANNY, phone: doc.phone });
  if (exists) { skipped += 1; continue; }
  // eslint-disable-next-line no-await-in-loop
  await User.create(doc);
  created += 1;
}

console.log(`\nSeeded ${created} nannies${skipped ? `, skipped ${skipped} already present` : ''}.`);

const verified = await User.countDocuments({ role: USER_ROLE.NANNY, nannyStatus: NANNY_STATUS.VERIFIED });
const total = await User.countDocuments({ role: USER_ROLE.NANNY });
console.log(`Nannies in the database: ${total} (${verified} verified and bookable).`);

await disconnectDB();
