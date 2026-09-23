import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import config from '../config/index.js';

/**
 * Permanent storage for the photos and videos a nanny sends.
 *
 * The problem this solves is not "where do the bytes go" but "do they still
 * exist next month". The archive used to be a folder inside the application
 * directory, and the hosts this runs on — Render, and most container
 * platforms — replace that directory on every deploy. Every photo, every
 * intro video, every ID document: gone, with the profiles still pointing at
 * them and nothing to recover from.
 *
 * So the files go somewhere the deploy cannot reach. S3-compatible object
 * storage, which means Cloudflare R2, Backblaze B2, Wasabi or S3 itself —
 * the same API for all of them, so the choice of provider stays a
 * configuration detail rather than a rewrite.
 *
 * Falls back to local disk when no credentials are configured. That is
 * deliberate: a developer should be able to clone this and run it without
 * signing up for anything, and a production deploy that forgets the keys
 * should degrade to the old behaviour with a loud warning rather than
 * refusing to accept a photo at all.
 */

const cfg = () => config.media.s3 || {};

/** Whether object storage is configured. Everything else keys off this. */
export const isConfigured = () => Boolean(
  cfg().bucket && cfg().accessKeyId && cfg().secretAccessKey && cfg().endpoint,
);

let client = null;

function s3() {
  if (client) return client;
  client = new S3Client({
    // R2 ignores region but the SDK requires one; "auto" is what R2 documents.
    region: cfg().region || 'auto',
    endpoint: cfg().endpoint,
    credentials: {
      accessKeyId: cfg().accessKeyId,
      secretAccessKey: cfg().secretAccessKey,
    },
    // R2 and most S3-compatibles need path-style addressing.
    forcePathStyle: true,
  });
  return client;
}

/** Content types we set on upload, so a browser renders rather than downloads. */
const CONTENT_TYPE = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

/**
 * The address a file is served from.
 *
 * `publicBase` is the CDN or bucket domain — on R2 that is the custom domain
 * or the r2.dev address. It is kept separate from the API endpoint because
 * uploading and serving happen over different hostnames, and using the API
 * endpoint as a public URL yields a link nobody outside the account can open.
 */
export function publicUrlFor(key) {
  const base = String(cfg().publicBase || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : null;
}

/** Is this object already there? Saves re-uploading a file we have. */
async function exists(key) {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: cfg().bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Put bytes in the bucket and return the URL they are served from.
 *
 * Throws on failure rather than returning null: the caller decides whether to
 * fall back to disk, and a silent null would look like success to anything
 * that only checked for an exception.
 */
export async function putObject(buf, { key, ext = '.jpg' }) {
  if (!isConfigured()) throw new Error('object storage is not configured');
  if (!buf?.length) throw new Error('empty file');

  const url = publicUrlFor(key);
  if (!url) throw new Error('MEDIA_PUBLIC_BASE is not set, so uploads would have no address');

  // Named by content hash upstream, so the same file re-sent is already here.
  if (await exists(key)) return url;

  await s3().send(new PutObjectCommand({
    Bucket: cfg().bucket,
    Key: key,
    Body: buf,
    ContentType: CONTENT_TYPE[ext.toLowerCase()] || 'application/octet-stream',
    // A year, immutable: the key is a hash of the contents, so a given key's
    // bytes can never change.
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return url;
}

/** What the health check reports, so a misconfiguration is visible. */
export function describe() {
  if (!isConfigured()) {
    return { mode: 'disk', permanent: false, reason: 'no object storage credentials set' };
  }
  if (!cfg().publicBase) {
    return { mode: 'disk', permanent: false, reason: 'MEDIA_PUBLIC_BASE is not set' };
  }
  return {
    mode: 'object-storage',
    permanent: true,
    bucket: cfg().bucket,
    publicBase: cfg().publicBase,
  };
}

export default { isConfigured, putObject, publicUrlFor, describe };
