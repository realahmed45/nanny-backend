import 'dotenv/config';
import mongoose from 'mongoose';
import config from '../config/index.js';
import {
  User, Booking, ChatThread, Payout, Otp, Session, Payment,
} from '../models/index.js';

/**
 * Empty the system of people.
 *
 * Removes every nanny and family and everything that hangs off them —
 * bookings, chats, payouts, conversation state. What is left is a working
 * system with nobody in it, ready for real registrations.
 *
 * Settings, areas and admin accounts are untouched: those are configuration,
 * not data about people, and losing them means setting the business up again.
 *
 * Refuses to run unless told twice. This deletes everything and there is no
 * undo, so an accidental `npm run` should do nothing at all.
 *
 *   node src/scripts/wipeSeeded.js --yes          # seeded (999…) only
 *   node src/scripts/wipeSeeded.js --yes --all    # every nanny and family
 */

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const everyone = args.includes('--all');

/** Seeded accounts are the unroutable 999 prefix the seed script uses. */
const SEEDED = /^999/;

async function main() {
  if (!confirmed) {
    console.log('This deletes people and their bookings. Nothing has been touched.');
    console.log('Run again with --yes to confirm, and --all to include real numbers.');
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const who = everyone ? {} : { phone: SEEDED };
  const label = everyone ? 'every nanny and family' : 'seeded (999…) accounts';

  const users = await User.find({
    role: { $in: ['nanny', 'family'] },
    ...who,
  }).select('_id role phone').lean();

  if (!users.length) {
    console.log(`Nothing to remove — no ${label} found.`);
    await mongoose.disconnect();
    return;
  }

  const ids = users.map((u) => u._id);
  const phones = users.map((u) => u.phone).filter(Boolean);
  const nannies = users.filter((u) => u.role === 'nanny').length;
  const families = users.length - nannies;

  console.log(`Removing ${label}:`);
  console.log(`  ${nannies} nannies`);
  console.log(`  ${families} families`);

  // Bookings first. A booking whose nanny and family no longer exist is not
  // recoverable data, it is a row that breaks every screen that loads it.
  const bookings = await Booking.deleteMany({
    $or: [{ family: { $in: ids } }, { nanny: { $in: ids } }, { secondNanny: { $in: ids } }],
  });
  const chats = await ChatThread.deleteMany({
    $or: [{ family: { $in: ids } }, { nanny: { $in: ids } }],
  });
  const payouts = await Payout.deleteMany({ nanny: { $in: ids } });

  const payments = await Payment.deleteMany({ family: { $in: ids } });

  // Conversation state and codes are keyed by phone, not by id.
  const convos = await Session.deleteMany({ phone: { $in: phones } });
  const otps = await Otp.deleteMany({ phone: { $in: phones } });

  const removed = await User.deleteMany({ _id: { $in: ids } });

  console.log(`\nDeleted:`);
  console.log(`  ${removed.deletedCount} people`);
  console.log(`  ${bookings.deletedCount} bookings`);
  console.log(`  ${chats.deletedCount} chats`);
  console.log(`  ${payouts.deletedCount} payouts`);
  console.log(`  ${payments.deletedCount} payments`);
  console.log(`  ${convos.deletedCount} conversations`);
  console.log(`  ${otps.deletedCount} codes`);

  const left = await User.countDocuments({ role: { $in: ['nanny', 'family'] } });
  console.log(`\n${left} nannies and families remain.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
