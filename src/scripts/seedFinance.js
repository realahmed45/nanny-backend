import 'dotenv/config';
import mongoose from 'mongoose';
import dayjs from 'dayjs';
import config from '../config/index.js';

/**
 * Fill the Finance page with a plausible month, so it can be looked at.
 *
 * An empty dashboard shows nothing about whether the dashboard is any good:
 * every figure reads zero, every table says "no records", and the layout
 * cannot be judged. This writes a month that behaves like a real one —
 * margins that differ by client, a nanny whose rate leaves too little, costs
 * across several categories, payouts in both settled and pending states.
 *
 *   node src/scripts/seedFinance.js            # report what it would write
 *   node src/scripts/seedFinance.js --apply    # write it
 *   node src/scripts/seedFinance.js --clear    # remove it again
 *
 * `--payments-only` writes the nannies and their payouts and nothing else —
 * no invented families, bookings or costs — for looking at the Payments tab
 * in a database that is waiting for real data.
 *
 * Everything it creates is tagged, so `--clear` removes exactly this and
 * leaves any real data alone. Phone numbers start 999, which the message
 * sender refuses to dial — seeded people cannot be messaged by accident.
 */

const APPLY = process.argv.includes('--apply');
const CLEAR = process.argv.includes('--clear');

/**
 * Payouts and the nannies they belong to, and nothing else.
 *
 * For looking at the Payments tab without putting invented families and
 * bookings into a database that is waiting for real ones.
 */
const PAYMENTS_ONLY = process.argv.includes('--payments-only');

/** Stamped on everything, so the cleanup is exact rather than approximate. */
const TAG = 'seed:finance';

const FAMILIES = [
  { name: 'The Harringtons', phone: '999700000001' },
  { name: 'Villa Alamanda', phone: '999700000002' },
  { name: 'The Okonkwos', phone: '999700000003' },
  { name: 'The Lindqvists', phone: '999700000004' },
];

// Rates chosen so the margins differ: Sari is the profitable placement,
// Wayan is the one whose rate leaves almost nothing.
const NANNIES = [
  { name: 'Sari Dewi', phone: '999800000001', rate: 45000 },
  { name: 'Ni Luh Putu', phone: '999800000002', rate: 55000 },
  { name: 'Wayan Astuti', phone: '999800000003', rate: 78000 },
];

const COSTS = [
  { day: 2, category: 'rent', description: 'Office rent — Canggu', amount: 6500000, recurring: true, paidTo: 'Pak Ketut' },
  { day: 3, category: 'software', description: 'WhatsApp Business API', amount: 890000, recurring: true },
  { day: 5, category: 'transport', description: 'Petrol — Ubud and Seminyak runs', amount: 420000 },
  { day: 8, category: 'marketing', description: 'Instagram ads, first fortnight', amount: 1750000 },
  { day: 11, category: 'supplies', description: 'Uniforms and name badges', amount: 980000 },
  { day: 14, category: 'salaries', description: 'Office coordinator — half month', amount: 4200000, recurring: true },
  { day: 17, category: 'transport', description: 'Airport pickup for a travel booking', amount: 350000 },
  { day: 19, category: 'fees', description: 'Bank transfer charges', amount: 145000 },
  { day: 22, category: 'utilities', description: 'Electricity and water', amount: 720000, recurring: true },
  { day: 24, category: 'supplies', description: 'First aid kits, 6x', amount: 640000 },
  { day: 26, category: 'marketing', description: 'Photographer for the new gallery', amount: 3200000 },
  // Deliberately voided, so the ledger shows what a corrected entry looks like.
  { day: 9, category: 'other', description: 'Duplicate of the Instagram invoice', amount: 1750000, voided: true },
];

/** A booking worked across `days` days, charged at `rate` to the family. */
function bookingDays(startDay, days, hoursPerDay, familyRate) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = dayjs().startOf('month').add(startDay - 1 + i * 2, 'day');
    out.push({
      date: d.format('YYYY-MM-DD'),
      status: 'completed',
      amount: familyRate * hoursPerDay,
      hours: hoursPerDay,
      startAt: d.hour(9).toDate(),
      endAt: d.hour(9 + hoursPerDay).toDate(),
      endConfirmedAt: d.hour(9 + hoursPerDay).toDate(),
    });
  }
  return out;
}

async function clear(models) {
  const { User, Booking, Cost, Payout } = models;
  const phones = [...FAMILIES, ...NANNIES].map((p) => p.phone);
  const users = await User.find({ phone: { $in: phones } }).select('_id');
  const ids = users.map((u) => u._id);

  const removed = {
    bookings: (await Booking.deleteMany({ $or: [{ family: { $in: ids } }, { nanny: { $in: ids } }] })).deletedCount,
    payouts: (await Payout.deleteMany({ nanny: { $in: ids } })).deletedCount,
    costs: (await Cost.deleteMany({ note: TAG })).deletedCount,
    people: (await User.deleteMany({ phone: { $in: phones } })).deletedCount,
  };

  console.log('Removed:');
  for (const [k, n] of Object.entries(removed)) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

async function main() {
  console.log('Database:', config.mongoUri.replace(/\/\/[^@]*@/, '//***@'));
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  const models = await import('../models/index.js');
  const { User, Booking, Cost, Payout, nextSequence } = models;

  if (CLEAR) {
    await clear(models);
    await mongoose.disconnect();
    return;
  }

  const month = dayjs().startOf('month');
  console.log(`Month   : ${month.format('MMMM YYYY')}`);
  console.log(`Families: ${FAMILIES.length}   Nannies: ${NANNIES.length}   Costs: ${COSTS.length}`);

  if (!APPLY) {
    console.log('\nDry run — pass --apply to write it, or --clear to remove it later.');
    await mongoose.disconnect();
    return;
  }

  // Idempotent: clear first, so running it twice does not double everything.
  await clear(models);
  console.log('');

  const families = [];
  if (!PAYMENTS_ONLY) {
    for (const f of FAMILIES) {
      families.push(await User.create({
        role: 'family', phone: f.phone, fullName: f.name, registrationComplete: true,
      }));
    }
  }

  const nannies = [];
  for (const n of NANNIES) {
    nannies.push(await User.create({
      role: 'nanny', phone: n.phone, fullName: n.name, hourlyRate: n.rate,
      nannyStatus: 'verified', registrationComplete: true,
    }));
  }

  /* ---- Bookings: who worked for whom, at what margin ---- */
  const PLAN = [
    { family: 0, nanny: 0, start: 1, days: 6, hours: 4, familyRate: 95000 },
    { family: 0, nanny: 0, start: 3, days: 4, hours: 6, familyRate: 95000 },
    { family: 1, nanny: 1, start: 2, days: 8, hours: 8, familyRate: 120000 },
    { family: 1, nanny: 2, start: 5, days: 3, hours: 4, familyRate: 95000 },
    // Wayan's rate against this family's price is the thin one.
    { family: 2, nanny: 2, start: 4, days: 5, hours: 6, familyRate: 90000 },
    { family: 3, nanny: 1, start: 7, days: 2, hours: 3, familyRate: 110000 },
  ];

  let bookings = 0;
  for (const p of (PAYMENTS_ONLY ? [] : PLAN)) {
    const days = bookingDays(p.start, p.days, p.hours, p.familyRate);
    await Booking.create({
      bookingNumber: await nextSequence('booking'),
      family: families[p.family]._id,
      nanny: nannies[p.nanny]._id,
      status: 'completed',
      hourlyRate: p.familyRate,
      nannyHourlyRate: NANNIES[p.nanny].rate,
      totalAmount: days.reduce((s, d) => s + d.amount, 0),
      serviceDays: days,
    });
    bookings += 1;
  }

  /* ---- Costs ---- */
  for (const c of (PAYMENTS_ONLY ? [] : COSTS)) {
    await Cost.create({
      spentOn: month.add(c.day - 1, 'day').toDate(),
      category: c.category,
      description: c.description,
      amount: c.amount,
      paidTo: c.paidTo,
      recurring: Boolean(c.recurring),
      voided: Boolean(c.voided),
      voidedAt: c.voided ? month.add(c.day, 'day').toDate() : undefined,
      voidReason: c.voided ? 'Entered twice' : undefined,
      note: TAG,
    });
  }

  /* ---- Payouts, in both states, plus one special cost ---- */
  const PAYOUTS = [
    { nanny: 0, amount: 2160000, status: 'completed', day: 8 },
    { nanny: 0, amount: 1080000, status: 'completed', day: 15 },
    { nanny: 1, amount: 3520000, status: 'completed', day: 8 },
    { nanny: 1, amount: 1760000, status: 'pending', day: 22 },
    { nanny: 2, amount: 2340000, status: 'pending', day: 22 },
    { nanny: 2, amount: 936000, status: 'failed', day: 15 },
  ];

  for (const [i, p] of PAYOUTS.entries()) {
    const at = month.add(p.day - 1, 'day').toDate();
    await Payout.create({
      reference: `SEED-${String(i + 1).padStart(4, '0')}`,
      nanny: nannies[p.nanny]._id,
      amount: p.amount,
      status: p.status,
      kind: 'earnings',
      scheduledFor: at,
      releasedAt: p.status === 'completed' ? at : undefined,
      createdAt: at,
    });
  }

  // One special payout, so the new category is visible on the page.
  await Payout.create({
    reference: 'SEED-S001',
    nanny: nannies[2]._id,
    amount: 285000,
    status: 'completed',
    kind: 'special',
    reason: 'Taxi to the Seminyak booking after her scooter broke down',
    costProof: { url: '/media/seed-receipt.jpg', uploadedAt: month.add(17, 'day').toDate() },
    proof: { url: '/media/seed-transfer.jpg', uploadedAt: month.add(18, 'day').toDate() },
    scheduledFor: month.add(17, 'day').toDate(),
    releasedAt: month.add(18, 'day').toDate(),
    createdAt: month.add(17, 'day').toDate(),
  });

  /* ---- One nanny on a contract, so that page is not empty either ---- */
  nannies[0].contract = {
    minimumHoursPerWeek: 40,
    minimumShiftsPerWeek: 5,
    safetyBufferPercent: 20,
    salaryPeriod: 'weekly',
    salaryAmount: 0,
    notes: 'Seeded example contract.',
  };
  await nannies[0].save();

  nannies[1].contract = {
    minimumHoursPerWeek: 120,
    minimumShiftsPerWeek: 18,
    safetyBufferPercent: 15,
    salaryPeriod: 'monthly',
    salaryAmount: 7500000,
    notes: 'Seeded example — monthly salary rather than hourly.',
  };
  await nannies[1].save();

  console.log('Written:');
  if (!PAYMENTS_ONLY) console.log(`  ${String(families.length).padStart(4)}  families`);
  console.log(`  ${String(nannies.length).padStart(4)}  nannies (2 on contracts)`);
  if (!PAYMENTS_ONLY) {
    console.log(`  ${String(bookings).padStart(4)}  completed bookings`);
    console.log(`  ${String(COSTS.length).padStart(4)}  costs (1 voided)`);
  }
  console.log(`  ${String(PAYOUTS.length + 1).padStart(4)}  payouts (1 special, with receipt)`);
  console.log('');
  console.log(`Open Finance for ${month.format('MMMM')} to see it.`);
  console.log('Remove it later with:  node src/scripts/seedFinance.js --clear');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
