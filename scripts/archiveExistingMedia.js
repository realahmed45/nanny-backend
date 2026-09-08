/**
 * Copy media that is still hosted by the WhatsApp provider into our own store.
 *
 * Anything uploaded before the archive existed still points at a file we do
 * not own and cannot stop being deleted. This walks every nanny, downloads
 * what is still remote, and repoints the profile at our copy.
 *
 * Only rewrites a record once the file is safely on disk, so a failure leaves
 * the original link in place rather than breaking a working profile. Safe to
 * run repeatedly — anything already archived is skipped.
 *
 * Run with --apply to write; without it, reports what it would do.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../src/models/index.js';
import { store } from '../src/services/mediaArchive.js';
import config from '../src/config/index.js';

const apply = process.argv.includes('--apply');

/** Ours already? Then there is nothing to do. */
const isOurs = (url) => !url || url.startsWith(config.publicBaseUrl);

await mongoose.connect(process.env.MONGODB_URI);

const nannies = await User.find({ role: 'nanny' });
let checked = 0;
let moved = 0;
let failed = 0;

for (const nanny of nannies) {
  let dirty = false;

  const fix = async (item, kind) => {
    if (isOurs(item.url)) return;
    checked += 1;
    if (!apply) {
      console.log(`  would archive ${kind}: ${item.url.slice(-40)}`);
      return;
    }
    const stored = await store(item.url, { mediaType: kind });
    if (stored === item.url) {
      failed += 1;
      console.log(`  FAILED ${kind}: ${item.url.slice(-40)}`);
      return;
    }
    item.url = stored;
    moved += 1;
    dirty = true;
  };

  for (const v of nanny.videos || []) await fix(v, 'video');
  for (const p of nanny.photos || []) await fix(p, 'image');
  for (const d of nanny.documents || []) await fix(d, 'image');

  if (!isOurs(nanny.profilePhotoUrl)) {
    checked += 1;
    if (apply) {
      const stored = await store(nanny.profilePhotoUrl, { mediaType: 'image' });
      if (stored !== nanny.profilePhotoUrl) {
        nanny.profilePhotoUrl = stored;
        moved += 1;
        dirty = true;
      } else {
        failed += 1;
      }
    } else {
      console.log(`  would archive profile photo: ${String(nanny.profilePhotoUrl).slice(-40)}`);
    }
  }

  if (dirty) {
    nanny.markModified('videos');
    nanny.markModified('photos');
    nanny.markModified('documents');
    await nanny.save();
    console.log(`${nanny.nickname || nanny.fullName}: updated`);
  }
}

console.log(
  apply
    ? `\nArchived ${moved} file(s). ${failed} could not be fetched (link already dead, most likely).`
    : `\n${checked} file(s) are still on the provider. Re-run with --apply to copy them.`,
);

await mongoose.disconnect();
