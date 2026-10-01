import {
  S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import config from '../config/index.js';

/**
 * Object storage for files nobody outside the office may see.
 *
 * Identity documents, signed contracts and payment receipts used to be written
 * to local disk even when the public media went to a bucket — and the local
 * disk on Render is replaced on every deploy. The evidence a nanny was
 * verified, or that a family paid, was destroyed by the next release.
 *
 * Kept apart from `objectStore.js` deliberately. That module uploads with a
 * year-long public cache header and hands back a public URL; a private file
 * must never get either. This one stores into a separate bucket that has no
 * public domain, and files come back out only through the logged-in
 * /media-private route, which streams them from here.
 */

const cfg = () => config.media.privateS3 || {};

/**
 * Configured, and not pointing at the public bucket.
 *
 * On R2 and most S3-compatibles a bucket with a public domain exposes every
 * key in it, so a private prefix inside the public bucket is not private at
 * all. Refused rather than accepted with a warning.
 */
export function isConfigured() {
  const c = cfg();
  if (!(c.bucket && c.accessKeyId && c.secretAccessKey && c.endpoint)) return false;
  const publicBucket = config.media.s3?.bucket;
  if (publicBucket && publicBucket === c.bucket) {
    if (!isConfigured.warned) {
      console.error('[media] MEDIA_PRIVATE_S3_BUCKET is the same as the public MEDIA_S3_BUCKET. '
        + 'Private files will NOT go there (anything in a public bucket is public). Use a separate bucket.');
      isConfigured.warned = true;
    }
    return false;
  }
  return true;
}

let client = null;

function s3() {
  if (client) return client;
  client = new S3Client({
    region: cfg().region || 'auto',
    endpoint: cfg().endpoint,
    credentials: {
      accessKeyId: cfg().accessKeyId,
      secretAccessKey: cfg().secretAccessKey,
    },
    forcePathStyle: true,
  });
  return client;
}

const keyFor = (name) => `${cfg().prefix || ''}${name}`;

export async function exists(name) {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name) }));
    return true;
  } catch {
    return false;
  }
}

/** Store bytes under `name`. Throws on failure; the caller decides the fallback. */
export async function putPrivate(buf, { name, contentType }) {
  if (!isConfigured()) throw new Error('private object storage is not configured');
  if (!buf?.length) throw new Error('empty file');
  if (await exists(name)) return;
  await s3().send(new PutObjectCommand({
    Bucket: cfg().bucket,
    Key: keyFor(name),
    Body: buf,
    ContentType: contentType || 'application/octet-stream',
    // Never cacheable by anything in between.
    CacheControl: 'private, no-store',
  }));
}

/**
 * Open a stored file for streaming, or null when it is not there.
 *
 * Returned as a stream so a 30MB contract scan is piped to the admin's browser
 * rather than held in memory.
 */
export async function getPrivate(name) {
  if (!isConfigured()) return null;
  try {
    const out = await s3().send(new GetObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name) }));
    return { body: out.Body, contentType: out.ContentType, length: out.ContentLength };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Upload an arbitrary object (used for the nightly database dump). */
export async function putRaw(key, buf, contentType = 'application/octet-stream') {
  if (!isConfigured()) throw new Error('private object storage is not configured');
  await s3().send(new PutObjectCommand({
    Bucket: cfg().bucket,
    Key: key,
    Body: buf,
    ContentType: contentType,
    CacheControl: 'private, no-store',
  }));
  return { bucket: cfg().bucket, key };
}

export function describe() {
  return isConfigured()
    ? { mode: 'object-storage', permanent: true, bucket: cfg().bucket, prefix: cfg().prefix || '' }
    : { mode: 'disk', permanent: false, reason: 'MEDIA_PRIVATE_S3_BUCKET (or credentials) not set' };
}

export default { isConfigured, exists, putPrivate, getPrivate, putRaw, describe };
