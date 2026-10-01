import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config/index.js';
import objectStore from './objectStore.js';
import privateStore from './privateStore.js';

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
 * Public media goes to the public bucket when one is configured, private
 * documents to a separate private bucket (privateStore.js); either falls back
 * to local disk, which only survives a deploy if it is a persistent volume.
 */

/** Where copies live, and the URL prefix they are served from. */
const ROOT = config.media.dir;
const PUBLIC_PREFIX = '/media';

/**
 * Files nobody outside the office may see.
 *
 * Everything used to land in one flat, publicly served folder: a nanny's
 * national ID next to her profile photo, a family's bank transfer receipt next
 * to a picture of a child. Anyone holding a link had it permanently, because
 * the files are served `immutable` for a year with no way to withdraw one, and
 * the names are a hash of the file's own contents rather than a secret.
 *
 * Profile photos and work videos genuinely have to stay public: WhatsApp
 * fetches them from this server in order to deliver them, so locking them away
 * would stop a family ever seeing a nanny's picture. Identity documents,
 * certificates, signed contracts and payment proofs are never sent to anybody —
 * they exist to be checked by an admin — so they go here instead, behind the
 * dashboard login.
 *
 * The private folder used to be MEDIA_DIR/private, inside the public root,
 * kept out of the public mount only by comparing the first path segment to
 * "private". `/media/%70rivate/<file>` and `/media/./private/<file>` both
 * normalise to that folder after the check had passed, so every ID was one
 * oddly spelled URL away from anyone. It now lives outside the public root
 * entirely; nothing the public mount can resolve reaches it.
 */
const PRIVATE_PREFIX = '/media-private';
const LEGACY_PRIVATE_ROOT = path.join(ROOT, 'private');
const PRIVATE_ROOT = (() => {
  const wanted = config.media.privateDir;
  const rel = path.relative(path.resolve(ROOT), path.resolve(wanted));
  // Same mistake again by configuration: a private dir inside the public one.
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    const fallback = `${ROOT.replace(/[\\/]+$/, '')}-private`;
    console.error(`[media] MEDIA_PRIVATE_DIR "${wanted}" is inside the public MEDIA_DIR "${ROOT}" — `
      + `that would make private files public. Using "${fallback}" instead.`);
    return fallback;
  }
  return wanted;
})();

/**
 * What we are willing to keep, by content type.
 *
 * The extension used to come from the provider's URL, so a file sent as
 * "x.html" or "x.svg" was saved as exactly that and served from our own
 * domain — a stored script running with our origin. The extension now comes
 * only from this list, keyed by the type the file actually declared (or its
 * first bytes, when it declared nothing useful). Private documents are
 * narrower still: an ID or a receipt is a picture or a PDF.
 */
const PUBLIC_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
};
const PRIVATE_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
const PUBLIC_EXTS = new Set([...Object.values(PUBLIC_TYPES), '.jpeg']);
const PRIVATE_EXTS = new Set([...Object.values(PRIVATE_TYPES), '.jpeg']);

/** Served type for each extension we keep. */
const TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.3gp': 'video/3gpp',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
};

/** Recognise a file by its first bytes, for providers that label everything octet-stream. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('%PDF')) return 'application/pdf';
  if (ascii.slice(4, 8) === 'ftyp') return ascii.slice(8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3')) return 'audio/mpeg';
  if (ascii.startsWith('#!AMR')) return 'audio/amr';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  return null;
}

/**
 * Is this a URL we are allowed to fetch?
 *
 * Only the WhatsApp provider's media storage (config.media.allowedSources).
 * `store()` runs inside our network, so fetching "any http URL" let whoever
 * could put a URL in front of it make this server request internal services
 * or the cloud metadata address and keep the answer.
 */
export function isAllowedSource(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  const pathname = u.pathname.toLowerCase();

  return (config.media.allowedSources || []).some((entry) => {
    const slash = entry.indexOf('/');
    const h = slash === -1 ? entry : entry.slice(0, slash);
    const prefix = slash === -1 ? '' : entry.slice(slash);
    const hostOk = h.startsWith('*.')
      ? host.endsWith(h.slice(1)) && host.length > h.length - 1
      : host === h;
    return hostOk && (!prefix || pathname.startsWith(prefix));
  });
}

/**
 * Download, with every limit enforced while the bytes arrive.
 *
 * Redirects are followed by hand, and only to another allowed source — the
 * default would follow a redirect from an allowed host to anywhere. The size
 * is checked from Content-Length before reading and again as each chunk
 * arrives, so a file that lies about its length (or sends none) is cut off at
 * the limit instead of being read whole into memory.
 */
async function download(remoteUrl) {
  let url = remoteUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!isAllowedSource(url)) throw new Error('source is not an allowed media host');

    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!next) throw new Error(`provider redirected (${res.status}) with no location`);
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`provider returned ${res.status}`);

    const max = config.media.maxBytes;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`file is ${Math.round(declared / 1e6)}MB, over the limit`);
    }

    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new Error('file is over the size limit');
      }
      chunks.push(Buffer.from(value));
    }

    const buf = Buffer.concat(chunks, total);
    if (!buf.length) throw new Error('empty file');
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return { buf, contentType };
  }
  throw new Error('too many redirects');
}

/**
 * The extension to save under, from the type list — or null to refuse.
 *
 * A declared type that is on the list is used. A generic or missing one is
 * replaced by what the bytes say. A declared type that is specific and not on
 * the list (text/html, image/svg+xml, application/javascript) is refused even
 * if the bytes look like something else.
 */
function extFor(contentType, buf, isPrivate) {
  const table = isPrivate ? PRIVATE_TYPES : PUBLIC_TYPES;
  const generic = !contentType
    || contentType === 'application/octet-stream'
    || contentType === 'binary/octet-stream'
    || contentType === 'application/binary';
  const type = generic ? sniff(buf) : contentType;
  return (type && table[type]) || null;
}

const hashOf = (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 20);

/** True once the file exists locally, so a retry does not download twice. */
async function exists(p) {
  try {
    const stat = await fs.stat(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/** Write via a temporary name, so a crash cannot leave a half-file that looks complete. */
async function writeAtomic(dir, name, buf) {
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, name);
  const tmp = `${dest}.part`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dest);
}

/** Is there already a local copy, under either the new or the old private folder? */
async function privateLocalPath(name) {
  for (const dir of [PRIVATE_ROOT, LEGACY_PRIVATE_ROOT]) {
    const p = path.join(dir, name);
    // eslint-disable-next-line no-await-in-loop
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * Put a private file somewhere permanent, and return its logged-in URL.
 *
 * Private files were always written to local disk, even with a bucket
 * configured — and the local disk is wiped on every deploy, taking every ID,
 * contract and receipt with it. They now go to the private bucket when there
 * is one, and to disk only as a fallback (logged loudly, as the public side is).
 */
async function savePrivate(buf, name) {
  const url = `${PRIVATE_PREFIX}/${name}`;
  if (privateStore.isConfigured()) {
    try {
      await privateStore.putPrivate(buf, {
        name,
        contentType: TYPE_BY_EXT[path.extname(name)] || 'application/octet-stream',
      });
      return url;
    } catch (err) {
      console.error(`[media] private object storage upload failed for ${name}: ${err.message}`);
      console.error('[media] falling back to local disk — this ID/receipt will not survive a deploy');
    }
  }
  if (await privateLocalPath(name)) return url;
  await writeAtomic(PRIVATE_ROOT, name, buf);
  return url;
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
export async function store(remoteUrl, { mediaType, private: isPrivate = false } = {}) {
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return remoteUrl;
  if (!config.media.enabled) return remoteUrl;

  try {
    if (!isAllowedSource(remoteUrl)) {
      throw new Error('not from an allowed media host (MEDIA_ALLOWED_SOURCES); not downloaded');
    }

    // Named by where it came from, so the same message retried is one file.
    // The extension is only a guess until the bytes arrive; it is used for the
    // cheap "already have it" check and nothing else.
    const hash = hashOf(String(remoteUrl));
    const guessed = path.extname(new URL(remoteUrl).pathname).toLowerCase()
      || ({ video: '.mp4', image: '.jpg', audio: '.ogg', ptt: '.ogg', document: '.pdf' })[String(mediaType || '').toLowerCase()];
    const allowed = isPrivate ? PRIVATE_EXTS : PUBLIC_EXTS;

    if (guessed && allowed.has(guessed)) {
      const guessName = `${hash}${guessed === '.jpeg' ? '.jpg' : guessed}`;
      if (isPrivate) {
        if (await privateLocalPath(guessName)) return `${PRIVATE_PREFIX}/${guessName}`;
      } else if (await exists(path.join(ROOT, guessName))) {
        return `${PUBLIC_PREFIX}/${guessName}`;
      }
    }

    const { buf, contentType } = await download(remoteUrl);
    const ext = extFor(contentType, buf, isPrivate);
    if (!ext) {
      throw new Error(`file type "${contentType || 'unknown'}" is not one we keep${isPrivate ? ' for documents' : ''}`);
    }
    const name = `${hash}${ext}`;

    /**
     * An identity document arriving over WhatsApp goes behind the login, the
     * same as one uploaded from the phone app. It is never sent back out, so
     * nothing downstream needs it to be publicly reachable.
     */
    if (isPrivate) return await savePrivate(buf, name);

    // Same destination choice as an upload from the app: the bucket when it
    // is configured, so a photo that arrived over WhatsApp is as permanent
    // as one sent from the phone app.
    if (objectStore.isConfigured()) {
      try {
        return await objectStore.putObject(buf, { key: name, ext });
      } catch (err) {
        console.error(`[media] object storage upload failed for ${name}: ${err.message}`);
        console.error('[media] falling back to local disk — this copy will not survive a deploy');
      }
    }

    // Stored relative, not as a full URL.
    //
    // Baking the hostname in ties every record to wherever the server happened
    // to be running when the file arrived — archive something locally and the
    // live site serves a profile full of links to localhost. A path is correct
    // on every host, and the browser resolves it against whatever is serving
    // the page.
    const publicUrl = `${PUBLIC_PREFIX}/${name}`;
    if (await exists(path.join(ROOT, name))) return publicUrl;
    await writeAtomic(ROOT, name, buf);
    return publicUrl;
  } catch (err) {
    // The URL may carry a provider token in its query string; the path is
    // enough to find it in the log.
    let shown = remoteUrl;
    try { const u = new URL(remoteUrl); shown = `${u.origin}${u.pathname}`; } catch { /* keep */ }
    console.error(`[media] could not archive ${shown}: ${err.message}`);
    return remoteUrl;
  }
}

/**
 * Write bytes we were handed directly, rather than fetched.
 *
 * The phone app uploads a photo it already holds; there is no remote URL to
 * copy from. Unlike `store`, this throws on failure: an upload that silently
 * did nothing would leave her looking at a success screen and a profile that
 * never changed.
 */
export async function storeBuffer(buf, { ext = '.jpg', private: isPrivate = false } = {}) {
  if (!config.media.enabled) throw new Error('media archive is disabled');
  if (!buf?.length) throw new Error('empty file');
  if (buf.length > config.media.maxBytes) {
    throw new Error(`File is ${Math.round(buf.length / 1e6)}MB, over the ${Math.round(config.media.maxBytes / 1e6)}MB limit`);
  }

  // Callers already check their own lists; this is the last line, so an
  // .html or .svg can never be written to a folder served from our domain.
  const cleanExt = String(ext || '').toLowerCase();
  if (!(isPrivate ? PRIVATE_EXTS : PUBLIC_EXTS).has(cleanExt)) {
    throw new Error(`That file type (${cleanExt || 'none'}) is not accepted`);
  }

  // Named by content, so the same picture sent twice is stored once.
  const name = `${hashOf(buf)}${cleanExt}`;

  if (isPrivate) return savePrivate(buf, name);

  /**
   * Object storage first, when it is configured.
   *
   * This is the path that makes the archive permanent: the bucket is not
   * touched by a deploy, so a photo sent today is still there after the next
   * release, the one after that, and a move to a different host.
   *
   * A failure here falls through to disk rather than throwing. A nanny who
   * has just recorded her intro video should not lose it because the bucket
   * was briefly unreachable — a file on an ephemeral disk is worth more than
   * no file, for as long as that disk lasts, and the error is logged loudly
   * enough to be noticed.
   */
  if (objectStore.isConfigured()) {
    try {
      return await objectStore.putObject(buf, { key: name, ext: cleanExt });
    } catch (err) {
      console.error(`[media] object storage upload failed for ${name}: ${err.message}`);
      console.error('[media] falling back to local disk — this copy will not survive a deploy');
    }
  }

  const publicUrl = `${PUBLIC_PREFIX}/${name}`;
  if (await exists(path.join(ROOT, name))) return publicUrl;
  await writeAtomic(ROOT, name, buf);
  return publicUrl;
}

/** Copy several, keeping order. Failures fall back to their original URL. */
export async function storeAll(urls = [], opts = {}) {
  return Promise.all(urls.map((u) => store(u, opts)));
}

/**
 * Move a file that was archived publicly into private storage.
 *
 * For the one-off migration of IDs and receipts archived before private
 * storage existed. Reads the public copy (local disk or public bucket URL),
 * saves it privately under the same name, and deletes the local public copy so
 * the old link stops working. Returns the new /media-private URL.
 */
export async function movePublicToPrivate(publicName, { deletePublic = true } = {}) {
  const name = path.basename(String(publicName));
  if (!/^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/i.test(name)) throw new Error(`unsafe file name "${publicName}"`);
  const ext = path.extname(name).toLowerCase();
  if (!PRIVATE_EXTS.has(ext)) throw new Error(`"${ext}" is not a document type`);

  const url = `${PRIVATE_PREFIX}/${name}`;
  const localPublic = path.join(ROOT, name);
  let buf = null;
  let source = null;
  if (await exists(localPublic)) {
    buf = await fs.readFile(localPublic);
    source = 'disk';
  } else {
    const remote = objectStore.publicUrlFor?.(name);
    if (remote) {
      const res = await fetch(remote, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        buf = Buffer.from(await res.arrayBuffer());
        source = 'bucket';
      }
    }
  }
  if (!buf?.length) {
    // Already moved on an earlier run: nothing public left, the private copy stands.
    if (await privateLocalPath(name) || (privateStore.isConfigured() && await privateStore.exists(name))) {
      return { url, moved: false, alreadyPrivate: true, source: null };
    }
    throw new Error(`no copy of ${name} found on disk or in the public bucket`);
  }

  await savePrivate(buf, name);
  if (deletePublic && source === 'disk') await fs.unlink(localPublic);
  return { url, moved: true, source };
}

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
  if (!path.isAbsolute(ROOT)) {
    console.warn(
      `[media] WARNING: MEDIA_DIR is "${ROOT}", a path inside the app directory.\n`
      + '[media] On a host that redeploys by replacing that directory (Render, Heroku,\n'
      + '[media] most containers) every archived photo and video is destroyed on the\n'
      + '[media] next deploy, and the profiles pointing at them break with no way back.\n'
      + '[media] Fix it one of two ways:\n'
      + '[media]   1. Object storage (recommended — survives a host move too):\n'
      + '[media]      set MEDIA_S3_BUCKET, MEDIA_S3_ENDPOINT, MEDIA_S3_KEY,\n'
      + '[media]      MEDIA_S3_SECRET and MEDIA_PUBLIC_BASE.\n'
      + '[media]   2. A persistent disk: mount one and set MEDIA_DIR to it,\n'
      + '[media]      e.g. /var/data/media on Render.',
    );
  }
  if (!privateStore.isConfigured() && !path.isAbsolute(PRIVATE_ROOT)) {
    console.warn(
      `[media] WARNING: private documents (IDs, contracts, payment receipts) are on local disk at "${PRIVATE_ROOT}".\n`
      + '[media] They will be destroyed on the next deploy. Set MEDIA_PRIVATE_S3_BUCKET (a separate,\n'
      + '[media] non-public bucket) or point MEDIA_PRIVATE_DIR at a persistent disk.',
    );
  }
}

/**
 * Move private files out of the old in-public-root folder.
 *
 * Everything archived before this change sits in MEDIA_DIR/private. Moved once
 * at startup so the public root holds nothing private at all; until it has
 * run (or if a move fails) the logged-in route still looks there, and the
 * public mount still refuses the folder by name.
 */
async function moveLegacyPrivateFiles() {
  let names;
  try {
    names = await fs.readdir(LEGACY_PRIVATE_ROOT);
  } catch {
    return; // nothing there — the normal case after the first run
  }
  await fs.mkdir(PRIVATE_ROOT, { recursive: true });
  let moved = 0;
  for (const n of names) {
    if (n.endsWith('.part')) continue;
    const from = path.join(LEGACY_PRIVATE_ROOT, n);
    const to = path.join(PRIVATE_ROOT, n);
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await exists(to)) {
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(from);
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fs.rename(from, to);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          // Different disk: copy, then remove.
          // eslint-disable-next-line no-await-in-loop
          await fs.copyFile(from, to);
          // eslint-disable-next-line no-await-in-loop
          await fs.unlink(from);
        }
      }
      moved += 1;
    } catch (err) {
      console.error(`[media] could not move private file ${n} out of the public folder: ${err.message}`);
    }
  }
  await fs.rmdir(LEGACY_PRIVATE_ROOT).catch(() => {});
  if (moved) console.log(`[media] moved ${moved} private file(s) from ${LEGACY_PRIVATE_ROOT} to ${PRIVATE_ROOT}`);
}

/**
 * Does a public request resolve anywhere near a private folder?
 *
 * Checked on the decoded, normalised path — the form the static handler will
 * actually open — and case-insensitively with both slash directions, because
 * Windows and some filesystems treat "Private" and "\" as the same thing.
 */
function touchesPrivate(reqPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    return true;
  }
  const normal = path.posix.normalize(decoded.replace(/\\/g, '/')).toLowerCase();
  return normal.split('/').some((seg) => seg === 'private' || seg === '..');
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

  moveLegacyPrivateFiles().catch((err) => console.error(`[media] legacy private move failed: ${err.message}`));

  /**
   * The public archive.
   *
   * Still refuses anything that resolves to a "private" segment, as a second
   * lock: the private folder no longer lives here, but a copy left behind by a
   * failed move must not become reachable. `nosniff` and a sandboxing CSP mean
   * that even a file that slipped past the type list cannot run as a page on
   * our domain.
   */
  app.use(PUBLIC_PREFIX, (req, res, next) => {
    if (touchesPrivate(req.path)) return res.status(404).end();
    return next();
  }, express.static(ROOT, {
    maxAge: '365d',
    immutable: true,
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  }));

  /**
   * Identity documents, certificates, contracts and payment proofs.
   *
   * Behind the dashboard login, and only for the roles in MEDIA_PRIVATE_ROLES
   * (admin and super_admin by default). Any signed-in role used to be enough,
   * so every support and finance login could open every nanny's national ID.
   *
   * Deliberately not cached: an admin who signs out should not leave a
   * national ID sitting in a shared browser's cache. The auth middleware is
   * imported here rather than at the top of the file because this module is
   * also loaded by scripts that have no business pulling it in.
   *
   * Looked up in the private folder, then the old in-public-root folder (for
   * anything not yet moved), then the private bucket — streamed through this
   * route, never redirected to a bucket URL.
   */
  app.use(PRIVATE_PREFIX, async (req, res, next) => {
    const { requireAuth } = await import('../middleware/auth.js');
    return requireAuth(req, res, next);
  }, async (req, res, next) => {
    const { requireRole } = await import('../middleware/auth.js');
    return requireRole(...config.media.privateRoles)(req, res, next);
  }, async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();

    const name = req.path.replace(/^\/+/, '');
    // A bare file name in our own naming scheme, and nothing else: no
    // directories, no dots up front, no encoded separators.
    if (!/^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/i.test(name)) return res.status(404).end();

    const type = TYPE_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    try {
      const local = await privateLocalPath(name);
      if (local) {
        res.type(type);
        return res.sendFile(path.resolve(local), { dotfiles: 'deny', headers: { 'Cache-Control': 'private, no-store' } });
      }

      const obj = await privateStore.getPrivate(name);
      if (!obj) return res.status(404).end();
      res.type(type);
      if (obj.length) res.setHeader('Content-Length', String(obj.length));
      if (req.method === 'HEAD') return res.end();
      obj.body.on('error', (err) => {
        console.error(`[media] private stream failed for ${name}: ${err.message}`);
        res.destroy(err);
      });
      return obj.body.pipe(res);
    } catch (err) {
      return next(err);
    }
  });
}

export default {
  store, storeAll, storeBuffer, mountMediaRoutes, movePublicToPrivate, isAllowedSource,
};
