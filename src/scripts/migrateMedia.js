import fs from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import config from '../config/index.js';
import objectStore from '../services/objectStore.js';

/**
 * Move an existing local media archive into object storage.
 *
 * Run once, after the bucket is configured and before the next deploy — the
 * deploy is what destroys the local copies, so this is the window in which
 * the files still exist to be moved.
 *
 *   node src/scripts/migrateMedia.js            # report what would move
 *   node src/scripts/migrateMedia.js --apply    # actually upload
 *
 * Deliberately additive: nothing is deleted from disk. If the upload was
 * wrong in some way that only shows up later, the originals are still there
 * until the host removes them, which buys a second attempt.
 *
 * Safe to run twice. Keys are content hashes and the uploader skips anything
 * already in the bucket, so a re-run costs a few HEAD requests and no
 * duplicate storage.
 */

const APPLY = process.argv.includes('--apply');
const REWRITE = process.argv.includes('--rewrite-urls');

/** The URLs stored in the database are relative; these become absolute. */
function keyFor(filename) {
  return filename;
}

async function main() {
  if (!objectStore.isConfigured()) {
    console.error('Object storage is not configured.');
    console.error('Set MEDIA_S3_BUCKET, MEDIA_S3_ENDPOINT, MEDIA_S3_KEY,');
    console.error('MEDIA_S3_SECRET and MEDIA_PUBLIC_BASE, then run this again.');
    process.exit(1);
  }

  const where = objectStore.describe();
  if (!where.permanent) {
    console.error(`Object storage is half-configured: ${where.reason}`);
    process.exit(1);
  }

  const root = config.media.dir;
  let files;
  try {
    files = await fs.readdir(root);
  } catch (err) {
    console.error(`Cannot read ${root}: ${err.message}`);
    process.exit(1);
  }

  // `.part` files are interrupted downloads, not archived media.
  const media = files.filter((f) => !f.startsWith('.') && !f.endsWith('.part'));

  console.log(`Archive   : ${path.resolve(root)}`);
  console.log(`Bucket    : ${where.bucket}`);
  console.log(`Served at : ${where.publicBase}`);
  console.log(`Files     : ${media.length}`);
  console.log(APPLY ? '\nUploading…\n' : '\nDry run — pass --apply to upload.\n');

  let moved = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const name of media) {
    const full = path.join(root, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) { skipped += 1; continue; }

    if (!APPLY) {
      console.log(`  would upload  ${name}  (${Math.round(stat.size / 1024)}KB)`);
      moved += 1;
      bytes += stat.size;
      continue;
    }

    try {
      const buf = await fs.readFile(full);
      const url = await objectStore.putObject(buf, {
        key: keyFor(name),
        ext: path.extname(name),
      });
      console.log(`  ok  ${name} -> ${url}`);
      moved += 1;
      bytes += stat.size;
    } catch (err) {
      console.error(`  FAILED  ${name}: ${err.message}`);
      failed += 1;
    }
  }

  console.log('');
  console.log(`${APPLY ? 'Uploaded' : 'Would upload'}: ${moved} file(s), ${Math.round(bytes / 1024)}KB`);
  if (skipped) console.log(`Skipped   : ${skipped} (empty or not a file)`);
  if (failed) console.log(`Failed    : ${failed}`);

  /**
   * The database still holds relative paths.
   *
   * Those keep working: the app serves /media/* from disk for as long as the
   * disk lasts, and every *new* file gets an absolute bucket URL. Rewriting
   * the old rows is a separate decision — see the note below — because it is
   * the one step that cannot be undone by re-running anything.
   */
  if (APPLY && moved > 0) {
    console.log('');
    console.log('Files are in the bucket. Existing profiles still point at /media/…');
    console.log('paths, which work until this host replaces the directory.');
    console.log('');
    console.log('To point them at the bucket permanently, run:');
    console.log('  node src/scripts/migrateMedia.js --apply --rewrite-urls');
  }

  if (REWRITE && APPLY) await rewriteUrls(where.publicBase);

  if (failed > 0) process.exit(1);
}

/**
 * Point every stored media path at the bucket.
 *
 * Until this runs, a profile says `/media/abc.jpg` and the app serves it from
 * whatever disk it has. That works right up until the deploy that replaces
 * the disk, at which point every one of those paths is a broken link.
 *
 * Rewriting them to absolute bucket URLs is what makes the profiles outlive
 * the host. Done last and behind its own flag because it is the one step a
 * re-run cannot undo: after this the rows no longer reference the local
 * archive at all.
 */
async function rewriteUrls(publicBase) {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(config.mongoUri);

  const { User } = await import('../models/index.js');
  const base = String(publicBase).replace(/\/+$/, '');

  // Every place a nanny's media lives. Documents carry ID scans, which are
  // the ones it would be worst to lose.
  const FIELDS = ['videos', 'photos', 'profilePictures', 'documents'];

  const nannies = await User.find({
    $or: FIELDS.map((f) => ({ [`${f}.0`]: { $exists: true } })),
  });

  let changed = 0;
  let urls = 0;

  for (const nanny of nannies) {
    let touched = false;

    for (const field of FIELDS) {
      for (const item of nanny[field] || []) {
        // Only the relative ones. Anything already absolute is either
        // migrated or was never ours to move.
        if (!item.url || !item.url.startsWith('/media/')) continue;
        item.url = `${base}/${item.url.slice('/media/'.length)}`;
        urls += 1;
        touched = true;
      }
    }

    // The resolved profile picture is stored separately from the array.
    if (nanny.profilePhotoUrl?.startsWith('/media/')) {
      nanny.profilePhotoUrl = `${base}/${nanny.profilePhotoUrl.slice('/media/'.length)}`;
      urls += 1;
      touched = true;
    }

    if (touched) {
      for (const field of FIELDS) nanny.markModified(field);
      await nanny.save();
      changed += 1;
    }
  }

  console.log('');
  console.log(`Rewrote ${urls} URL(s) across ${changed} nanny profile(s).`);
  console.log('Profiles now point at the bucket and no longer depend on this host.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
