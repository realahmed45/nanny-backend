import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config/index.js';

/**
 * Keep our own copy of every photo and video a nanny sends.
 *
 * The problem this solves: media arrives as a link to a file on the WhatsApp
 * provider's servers. We do not own those files, we cannot stop them being
 * deleted, and when they go the profiles empty themselves with no warning and
 * no way to recover. A profile built on somebody else's disk is a profile with
 * an expiry date.
 *
 * So every incoming file is copied here the moment it arrives, and the profile
 * points at our copy. Nobody can remove it but us — not the nanny, not the
 * provider — which is also what makes it evidence if a submission is ever
 * disputed.
 *
 * Deliberately plain files on disk rather than a cloud SDK: it works today
 * with nothing to sign up for, and the only thing that must be got right is
 * that the directory is on persistent storage and included in your server
 * backups. Swapping in S3 or similar later means changing `store()` alone.
 */

/** Where copies live, and the URL prefix they are served from. */
const ROOT = config.media.dir;
const PUBLIC_PREFIX = '/media';

/** Extensions we are willing to write, by what the provider called the file. */
const EXT_BY_TYPE = {
  video: '.mp4',
  image: '.jpg',
  audio: '.ogg',
  document: '.pdf',
};

/** A file name that cannot collide and cannot escape the directory. */
function safeName(url, mediaType) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20);
  const fromUrl = path.extname(new URL(url, 'https://x').pathname).toLowerCase();
  const ext = /^\.[a-z0-9]{2,5}$/.test(fromUrl)
    ? fromUrl
    : (EXT_BY_TYPE[String(mediaType || '').toLowerCase()] || '.bin');
  return `${hash}${ext}`;
}

/** True once the file exists locally, so a retry does not download twice. */
async function exists(p) {
  try {
    const stat = await fs.stat(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Copy one remote file into our own storage.
 *
 * Returns the URL to use on the profile. On any failure it returns the
 * original URL rather than throwing: a nanny who has just sent her video
 * should not see an error because our disk was full, and a link that works
 * today is better than no link at all. The failure is logged so the gap is
 * visible.
 */
export async function store(remoteUrl, { mediaType } = {}) {
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return remoteUrl;
  if (!config.media.enabled) return remoteUrl;

  try {
    const name = safeName(remoteUrl, mediaType);
    const dest = path.join(ROOT, name);
    const publicUrl = `${config.publicBaseUrl}${PUBLIC_PREFIX}/${name}`;

    // Already have it — the same file re-sent, or a retry after a crash.
    if (await exists(dest)) return publicUrl;

    await fs.mkdir(ROOT, { recursive: true });

    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`provider returned ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty file');
    if (buf.length > config.media.maxBytes) {
      throw new Error(`file is ${Math.round(buf.length / 1e6)}MB, over the limit`);
    }

    // Written to a temporary name first, so a crash mid-download cannot leave
    // a half-file that later looks complete.
    const tmp = `${dest}.part`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, dest);

    return publicUrl;
  } catch (err) {
    console.error(`[media] could not archive ${remoteUrl}: ${err.message}`);
    return remoteUrl;
  }
}

/** Copy several, keeping order. Failures fall back to their original URL. */
export async function storeAll(urls = [], opts = {}) {
  return Promise.all(urls.map((u) => store(u, opts)));
}

/**
 * Serve the archive read-only.
 *
 * Mounted rather than exposed through a route so a request cannot reach
 * outside the directory, and with a long cache because a stored file never
 * changes — its name is a hash of where it came from.
 */
/**
 * Say so, loudly, when the archive is sitting somewhere that will be wiped.
 *
 * A relative MEDIA_DIR lives inside the deployed code directory, and hosts
 * that redeploy by replacing that directory — Render, Heroku, most container
 * platforms — destroy it every time. The failure is silent and delayed: the
 * files copy fine, the profiles look right, and then a deploy weeks later
 * turns every one of them into a dead link with nothing to recover from.
 *
 * This cannot be fixed in code. It needs a disk that outlives a deploy, so
 * the only honest thing is to be impossible to ignore about it.
 */
function warnIfEphemeral() {
  if (path.isAbsolute(ROOT)) return;
  console.warn(
    `[media] WARNING: MEDIA_DIR is "${ROOT}", a path inside the app directory.\n`
    + '[media] On a host that redeploys by replacing that directory (Render, Heroku,\n'
    + '[media] most containers) every archived photo and video is destroyed on the\n'
    + '[media] next deploy, and the profiles pointing at them break with no way back.\n'
    + '[media] Set MEDIA_DIR to a persistent disk — on Render, mount one and point\n'
    + '[media] MEDIA_DIR at it, e.g. /var/data/media.',
  );
}

export function mountMediaRoutes(app, express) {
  if (!config.media.enabled) return;
  warnIfEphemeral();

  // Creating the directory must never stop the server starting. This runs
  // while the app is being built, before the port is bound, so a read-only
  // filesystem or a bad MEDIA_DIR would take the whole deploy down and report
  // it as "no open ports" — a failure that points nowhere near the cause.
  try {
    fsSync.mkdirSync(ROOT, { recursive: true });
  } catch (err) {
    console.error(`[media] cannot use ${ROOT}: ${err.message}`);
    console.error('[media] photos and videos will not be archived. Set MEDIA_DIR to a writable path.');
    return;
  }

  app.use(PUBLIC_PREFIX, express.static(ROOT, {
    maxAge: '365d',
    immutable: true,
    index: false,
    dotfiles: 'deny',
  }));
}

export default { store, storeAll, mountMediaRoutes };
