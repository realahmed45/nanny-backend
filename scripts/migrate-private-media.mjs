/**
 * Move IDs, contracts and payment proofs out of the public media archive.
 *
 * HOW TO RUN (from the server folder, with the production .env / environment):
 *
 *   node scripts/migrate-private-media.mjs              # dry run: report only
 *   node scripts/migrate-private-media.mjs --apply      # move files, rewrite URLs
 *
 * Options:
 *   --apply               actually move files and update the database
 *   --fetch-raw           also archive (privately) documents that still point
 *                         at the WhatsApp provider's own URL — those links are
 *                         public and expire; many will already be dead
 *   --keep-public-copy    copy to private storage but leave the public file
 *                         (and the public-bucket object) in place
 *
 * Run it on the server that holds the media (or with the same MEDIA_DIR /
 * bucket settings), and AFTER deploying the code that adds private storage:
 * set MEDIA_PRIVATE_S3_BUCKET first if you use object storage, or the moved
 * files land on local disk.
 *
 * Why this exists: every file archived before private storage existed — a
 * nanny's national ID and CPR certificate, a family's ID, bank transfer
 * receipts, payout proofs, signed salary contracts — is still in the public
 * archive at /media/<name>, served to anyone with the link and cached
 * `immutable` for a year. This finds every such reference in the database,
 * moves the file into private storage, and rewrites the record to
 * /media-private/<name> (logged-in admins only).
 *
 * Fields covered:
 *   User.documents[].url            nanny ID front/back, CPR certificate
 *   User.idDocuments[].url          family ID front/back
 *   User.contract.documentUrl       signed salary contract
 *   Payment.proof.url               family transfer receipt
 *   Payment.refundProof.url         refund transfer receipt
 *   Payout.proof.url                proof we paid the nanny
 *   Payout.costProof.url            receipt behind a special payout
 *   Cost.receiptUrl                 business expense receipt
 *
 * Safe to re-run: anything already on /media-private is skipped, and a file
 * already moved by an earlier run is recognised rather than failed. A file
 * that is ALSO used as a public profile photo/video is copied but its public
 * copy is kept, so a profile never breaks.
 *
 * After running: if the public files were behind a CDN, purge /media/* (or at
 * least the names this prints) — they were served with a one-year cache.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import config from '../src/config/index.js';
import {
  User, Payment, Payout, Cost,
} from '../src/models/index.js';
import { movePublicToPrivate, store } from '../src/services/mediaArchive.js';

const apply = process.argv.includes('--apply');
const fetchRaw = process.argv.includes('--fetch-raw');
const keepPublic = process.argv.includes('--keep-public-copy');

const PUBLIC_BASE = String(config.media.s3?.publicBase || '').replace(/\/+$/, '');
const SITE_BASE = String(config.publicBaseUrl || '').replace(/\/+$/, '');

/**
 * The archive file name, if this URL points at the PUBLIC archive.
 *
 * Accepts the three shapes a public URL has had over time: relative
 * "/media/<name>", an absolute link to this server ("https://host/media/<name>",
 * from before URLs were stored relative), and the public bucket's own address.
 */
function publicName(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/media-private/')) return null;
  const local = url.match(/^(?:https?:\/\/[^/]+)?\/media\/([A-Za-z0-9_-]+\.[a-z0-9]{2,5})$/i);
  if (local) {
    // An absolute URL only counts if it is ours, not some other site's /media.
    if (/^https?:/i.test(url) && SITE_BASE && !url.startsWith(`${SITE_BASE}/`)
      && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
      // Different host: could be an old deploy URL of ours. Accept, but say so.
      console.warn(`  note: treating ${url} as ours (host differs from PUBLIC_BASE_URL)`);
    }
    return local[1];
  }
  if (PUBLIC_BASE && url.startsWith(`${PUBLIC_BASE}/`)) {
    const name = url.slice(PUBLIC_BASE.length + 1);
    return /^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/i.test(name) ? name : null;
  }
  return null;
}

const isProviderUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url) && !publicName(url)
  && !url.startsWith(`${SITE_BASE}/media-private/`);

/** Is the same file also used somewhere that must stay public? */
async function usedPublicly(name) {
  const re = new RegExp(`/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return Boolean(await User.exists({
    $or: [
      { profilePhotoUrl: re },
      { 'photos.url': re },
      { 'videos.url': re },
      { 'profilePictures.url': re },
    ],
  }));
}

/** Delete the object from the public bucket, so the old public link stops working. */
let s3Client = null;
async function deleteFromPublicBucket(name) {
  const c = config.media.s3 || {};
  if (!(c.bucket && c.endpoint && c.accessKeyId && c.secretAccessKey)) return false;
  const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  s3Client ||= new S3Client({
    region: c.region || 'auto',
    endpoint: c.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  await s3Client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: name }));
  return true;
}

const stats = {
  found: 0, moved: 0, already: 0, rewritten: 0, raw: 0, rawArchived: 0, failed: 0, keptPublic: 0,
};
const doneNames = new Map(); // name -> new url, so a file shared by records moves once

/**
 * Work out the private URL for one reference, moving the file if needed.
 * Returns null when nothing should change.
 */
async function privateUrlFor(url, label) {
  const name = publicName(url);
  if (!name) {
    if (fetchRaw && isProviderUrl(url)) {
      stats.raw += 1;
      if (!apply) {
        console.log(`  would archive raw provider link privately: ${label}`);
        return null;
      }
      const stored = await store(url, { private: true });
      if (stored.startsWith('/media-private/')) {
        stats.rawArchived += 1;
        return stored;
      }
      stats.failed += 1;
      console.log(`  FAILED (provider link dead or not allowed): ${label}`);
    }
    return null;
  }

  stats.found += 1;
  if (doneNames.has(name)) return doneNames.get(name);
  if (!apply) {
    console.log(`  would move ${name}  (${label})`);
    return null;
  }

  try {
    const shared = await usedPublicly(name);
    const result = await movePublicToPrivate(name, { deletePublic: !keepPublic && !shared });
    if (shared) {
      stats.keptPublic += 1;
      console.log(`  ${name}: also used as public profile media — public copy kept`);
    }
    if (result.moved) stats.moved += 1; else stats.already += 1;
    if (result.source === 'bucket' && !keepPublic && !shared) {
      await deleteFromPublicBucket(name).catch((err) => {
        console.error(`  could not delete ${name} from the public bucket: ${err.message} — delete it by hand`);
      });
    }
    doneNames.set(name, result.url);
    console.log(`  moved ${name} -> ${result.url}  (${label})`);
    return result.url;
  } catch (err) {
    stats.failed += 1;
    console.error(`  FAILED ${name} (${label}): ${err.message}`);
    return null;
  }
}

await mongoose.connect(config.mongoUri);
console.log(`Database: ${mongoose.connection.db.databaseName}  ${apply ? '(APPLYING CHANGES)' : '(dry run — nothing will change; use --apply)'}`);
console.log(`Public dir: ${config.media.dir}   Private dir: ${config.media.privateDir}   Private bucket: ${config.media.privateS3?.bucket || '(none — local disk)'}\n`);

/* Users: nanny documents, family ID documents, contract scan. */
const users = await User.find({
  $or: [
    { 'documents.0': { $exists: true } },
    { 'idDocuments.0': { $exists: true } },
    { 'contract.documentUrl': { $exists: true, $ne: '' } },
  ],
}).select('fullName role documents idDocuments contract.documentUrl').lean();

for (const u of users) {
  for (const field of ['documents', 'idDocuments']) {
    for (const d of u[field] || []) {
      if (field === 'documents' && d.type === 'profile_photo') continue; // public by design
      // eslint-disable-next-line no-await-in-loop
      const next = await privateUrlFor(d.url, `${u.role} ${u._id} ${field}.${d.type}`);
      if (next && next !== d.url && apply) {
        // eslint-disable-next-line no-await-in-loop
        await User.updateOne({ _id: u._id, [`${field}._id`]: d._id }, { $set: { [`${field}.$.url`]: next } });
        stats.rewritten += 1;
      }
    }
  }
  if (u.contract?.documentUrl) {
    // eslint-disable-next-line no-await-in-loop
    const next = await privateUrlFor(u.contract.documentUrl, `nanny ${u._id} contract`);
    if (next && next !== u.contract.documentUrl && apply) {
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne({ _id: u._id }, { $set: { 'contract.documentUrl': next } });
      stats.rewritten += 1;
    }
  }
}

/* Single-path fields on the money records. */
async function sweep(Model, paths, label) {
  const docs = await Model.find({ $or: paths.map((p) => ({ [p]: { $exists: true, $nin: [null, ''] } })) })
    .select(paths.join(' ')).lean();
  for (const doc of docs) {
    for (const p of paths) {
      const current = p.split('.').reduce((o, k) => o?.[k], doc);
      if (!current) continue;
      // eslint-disable-next-line no-await-in-loop
      const next = await privateUrlFor(current, `${label} ${doc._id} ${p}`);
      if (next && next !== current && apply) {
        // eslint-disable-next-line no-await-in-loop
        await Model.updateOne({ _id: doc._id }, { $set: { [p]: next } });
        stats.rewritten += 1;
      }
    }
  }
}

await sweep(Payment, ['proof.url', 'refundProof.url'], 'Payment');
await sweep(Payout, ['proof.url', 'costProof.url'], 'Payout');
await sweep(Cost, ['receiptUrl'], 'Cost');

console.log('\nSummary:', JSON.stringify(stats));
if (!apply) {
  console.log(`\n${stats.found} public reference(s) would be made private${fetchRaw ? `, ${stats.raw} raw provider link(s) archived` : ''}. Re-run with --apply.`);
} else {
  console.log('\nDone. If /media is behind a CDN, purge it — those files were cached publicly for up to a year.');
}

await mongoose.disconnect();
