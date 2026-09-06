/**
 * Restore videos dropped by the single-video registration bug.
 *
 * The NR_VIDEO step kept one video URL in the session and overwrote it each
 * time another arrived, so a nanny who sent several kept only the last. The
 * message log recorded every inbound media URL along with the state it
 * arrived in, which is enough to put the missing ones back.
 *
 * Only adds; never removes or reorders what is already on a profile. Run with
 * --apply to write, otherwise it reports what it would do.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { MessageLog, User } from '../src/models/index.js';

const apply = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);

const nannies = await User.find({ role: 'nanny' })
  .select('fullName phone videos photos').lean();

let changed = 0;

for (const n of nannies) {
  // Everything she sent while the registration was asking for a video.
  const logs = await MessageLog.find({
    phone: n.phone,
    direction: 'in',
    state: 'NR_VIDEO',
    mediaUrl: { $ne: null },
  }).sort({ createdAt: 1 }).lean();
  if (!logs.length) continue;

  const known = new Set([
    ...(n.videos || []).map((v) => v.url),
    ...(n.photos || []).map((p) => p.url),
  ]);
  const missing = logs.map((l) => l.mediaUrl).filter((u) => u && !known.has(u));
  if (!missing.length) continue;

  console.log(`\n${n.fullName} (${n.phone})`);
  console.log(`  on profile: ${(n.videos || []).length} video(s), ${(n.photos || []).length} photo(s)`);
  console.log(`  missing   : ${missing.length}`);
  for (const u of missing) console.log(`    + ${u.slice(-42)}`);

  if (apply) {
    // Unreviewed, like anything a nanny sends: an admin decides in the
    // Nanny videos tab whether it reaches families. Filed as videos because
    // that is the step they arrived at; a photo among them can be deleted
    // there, which is cheaper than guessing the type wrong.
    const additions = missing.map((url) => ({
      url,
      title: 'Recovered from registration',
      approved: false,
    }));
    await User.updateOne({ _id: n._id }, { $push: { videos: { $each: additions } } });
    console.log('  -> restored');
  }
  changed += 1;
}

console.log(
  changed
    ? `\n${apply ? 'Restored' : 'Would restore'} media for ${changed} nanny(ies).`
    : '\nNothing to restore.',
);
if (changed && !apply) console.log('Re-run with --apply to write.');

await mongoose.disconnect();
