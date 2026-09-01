/**
 * Clear family data so testing can start from scratch.
 *
 * Removes every family and everything attached to them — bookings, payments,
 * refunds, payouts, tickets, chat threads, callback requests, OTPs, sessions
 * and message logs. Nannies and admin accounts are left alone.
 *
 *   node reset-families.mjs          # show what would be deleted
 *   node reset-families.mjs --yes    # actually delete
 *
 * Sessions and message logs go too: without that the bot still remembers where
 * a number was mid-flow, and old transcripts keep showing in the dashboard, so
 * the "fresh start" would not be fresh.
 */
import dotenv from 'dotenv';

dotenv.config();

const CONFIRMED = process.argv.includes('--yes');

const { connectDB, disconnectDB } = await import('./src/config/db.js');
await connectDB();

const {
  User, Booking, Session, Ticket, ChatThread, MessageLog, CallbackRequest, Otp,
} = await import('./src/models/index.js');
const { Payment, Payout } = await import('./src/models/Payment.js');
const { USER_ROLE } = await import('./src/utils/constants.js');

const families = await User.find({ role: USER_ROLE.FAMILY }).select('_id phone fullName');
const familyIds = families.map((f) => f._id);
const familyPhones = families.map((f) => f.phone);

// Bookings belonging to those families, so their payments can be found too.
const bookings = await Booking.find({ family: { $in: familyIds } }).select('_id');
const bookingIds = bookings.map((b) => b._id);

const plan = [
  ['families', User, { role: USER_ROLE.FAMILY }],
  ['bookings', Booking, { family: { $in: familyIds } }],
  ['payments', Payment, { $or: [{ family: { $in: familyIds } }, { booking: { $in: bookingIds } }] }],
  ['payouts', Payout, { booking: { $in: bookingIds } }],
  ['tickets', Ticket, { raisedBy: { $in: familyIds } }],
  ['chat threads', ChatThread, { family: { $in: familyIds } }],
  ['callback requests', CallbackRequest, { $or: [{ family: { $in: familyIds } }, { phone: { $in: familyPhones } }] }],
  ['sessions', Session, {}],
  ['message logs', MessageLog, {}],
  ['otps', Otp, {}],
];

console.log(`Families found: ${families.length}`);
for (const f of families) console.log(`  - ${f.fullName || 'unnamed'} (${f.phone})`);
console.log('');

let total = 0;
for (const [label, Model, query] of plan) {
  // eslint-disable-next-line no-await-in-loop
  const n = await Model.countDocuments(query);
  total += n;
  console.log(`${CONFIRMED ? 'deleting' : 'would delete'} ${String(n).padStart(5)} ${label}`);
}

if (!CONFIRMED) {
  console.log(`\n${total} documents would be removed. Re-run with --yes to confirm.`);
  const nannies = await User.countDocuments({ role: USER_ROLE.NANNY });
  console.log(`(${nannies} nannies would be kept.)`);
  await disconnectDB();
  process.exit(0);
}

for (const [label, Model, query] of plan) {
  // eslint-disable-next-line no-await-in-loop
  const { deletedCount } = await Model.deleteMany(query);
  console.log(`  removed ${deletedCount} ${label}`);
}

const remainingNannies = await User.countDocuments({ role: USER_ROLE.NANNY });
const remainingFamilies = await User.countDocuments({ role: USER_ROLE.FAMILY });

console.log('');
console.log(`Done. Families: ${remainingFamilies}. Nannies kept: ${remainingNannies}.`);

await disconnectDB();
