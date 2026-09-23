import 'dotenv/config';
import mongoose from 'mongoose';
import config from '../config/index.js';

/**
 * Empty the operational data, keeping the system itself configured.
 *
 * For starting over with real people after testing: every nanny, family,
 * booking, payment and conversation goes, while the admin logins, pricing,
 * settings and areas stay — so the platform still runs, it just has nobody
 * in it yet.
 *
 *   node src/scripts/resetOperationalData.js              # report only
 *   node src/scripts/resetOperationalData.js --apply      # actually delete
 *
 * Nothing is deleted without --apply, and the target database is printed
 * first, because the one mistake this script could make is running against
 * production when somebody meant a test copy.
 */

const APPLY = process.argv.includes('--apply');

/**
 * What goes, and what stays.
 *
 * Kept deliberately: an admin locked out of their own dashboard cannot fix
 * anything, and re-entering the rate card and service areas by hand is both
 * tedious and a chance to get a price wrong.
 */
const WIPE = [
  ['User', 'nannies and families'],
  ['Booking', 'bookings'],
  ['Payment', 'family payments'],
  ['Payout', 'nanny payouts'],
  ['Session', 'WhatsApp conversations in progress'],
  ['ChatThread', 'relayed chats'],
  ['Ticket', 'support tickets'],
  ['CallbackRequest', 'callback requests'],
  ['MessageLog', 'message history'],
  ['Otp', 'verification codes'],
  ['Note', 'admin notes'],
  ['ReferralClick', 'referral clicks'],
  ['ShareLink', 'share links'],
  ['ShareLinkClick', 'share link clicks'],
  ['LinkAbuseAlert', 'link abuse alerts'],
];

const KEEP = [
  ['AdminUser', 'dashboard logins'],
  ['Setting', 'pricing, areas and runtime settings'],
  ['Cost', 'the finance cost ledger'],
  ['AuditLog', 'the record of who changed what'],
  ['Counter', 'booking number sequence'],
  ['Translation', 'cached translations'],
];

async function main() {
  const uri = config.mongoUri;
  console.log('Database:', uri.replace(/\/\/[^@]*@/, '//***@'));
  console.log('');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const models = await import('../models/index.js');

  console.log('WILL DELETE');
  let total = 0;
  for (const [name, label] of WIPE) {
    const Model = models[name];
    if (!Model) continue;
    const n = await Model.countDocuments();
    total += n;
    console.log(`  ${String(n).padStart(6)}  ${label}`);
  }

  console.log('');
  console.log('WILL KEEP');
  for (const [name, label] of KEEP) {
    const Model = models[name];
    if (!Model) continue;
    console.log(`  ${String(await Model.countDocuments()).padStart(6)}  ${label}`);
  }

  if (!APPLY) {
    console.log('');
    console.log(`Dry run — ${total} record(s) would be deleted.`);
    console.log('Pass --apply to do it. This cannot be undone.');
    await mongoose.disconnect();
    return;
  }

  console.log('');
  console.log('Deleting…');
  for (const [name, label] of WIPE) {
    const Model = models[name];
    if (!Model) continue;
    const { deletedCount } = await Model.deleteMany({});
    console.log(`  removed ${deletedCount} ${label}`);
  }

  console.log('');
  console.log('Done. Admin logins, settings and pricing are untouched.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
