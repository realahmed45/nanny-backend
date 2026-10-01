import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import {
  User, Booking, Payment, Note, CallbackRequest, Ticket,
} from '../models/index.js';
import { send, brandedEmail } from '../providers/email.js';
import config from '../config/index.js';
import { money } from '../utils/format.js';
import { USER_ROLE } from '../utils/constants.js';
import { encryptBuffer, encryptStream } from '../utils/backupCrypto.js';

/**
 * The end-of-day backup.
 *
 * One spreadsheet, one sheet per thing worth keeping, emailed out each night.
 * It exists because the database is the only copy of every family, nanny,
 * booking and payment, and a file in somebody's inbox is a copy that survives
 * losing the database entirely.
 *
 * The spreadsheet is deliberately a plain export: the columns are the ones a
 * person would want to answer a question without the dashboard. Money is
 * written as numbers so the file can be summed, and ids are included so rows
 * can be matched back up. It is not something a database can be restored
 * from, so a full dump of every collection is written alongside it
 * (`writeDatabaseDump` below). Both are encrypted with BACKUP_PASSWORD before
 * they go anywhere near an email.
 */

/** Ids are objects until they are strings; dates are dates until they are not. */
const str = (v) => (v == null ? '' : String(v));
const day = (d) => (d ? new Date(d) : null);

/** Add a sheet with a header row that stays visible while scrolling. */
function addSheet(book, name, columns, rows) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };
  return sheet;
}

/** Build the workbook. Exported so it can be tested without sending mail. */
export async function buildBackupWorkbook() {
  const [families, nannies, bookings, payments, notes, callbacks, tickets] = await Promise.all([
    User.find({ role: USER_ROLE.FAMILY }).lean(),
    User.find({ role: USER_ROLE.NANNY }).lean(),
    Booking.find().populate('family', 'fullName phone').populate('nanny', 'fullName nickname phone').lean(),
    Payment.find().lean(),
    Note.find().lean(),
    CallbackRequest.find().lean(),
    Ticket.find().lean(),
  ]);

  const book = new ExcelJS.Workbook();
  book.creator = config.brand.name;
  book.created = new Date();

  addSheet(book, 'Families', [
    { header: 'ID', key: 'id', width: 26 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Registered', key: 'registered', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Last active', key: 'lastSeen', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Referral code', key: 'code', width: 14 },
    { header: 'Referrals', key: 'referrals', width: 10 },
    { header: 'Instagram', key: 'ig', width: 18 },
    { header: 'IG verified', key: 'igOk', width: 11 },
    { header: 'Number saved', key: 'waOk', width: 13 },
    { header: 'Blocked', key: 'blocked', width: 9 },
  ], families.map((f) => ({
    id: str(f._id),
    name: f.fullName,
    phone: f.phone,
    email: f.email,
    registered: day(f.createdAt),
    lastSeen: day(f.lastSeenAt),
    code: f.referralCode,
    referrals: f.referralCount || 0,
    ig: f.social?.instagramHandle || '',
    igOk: f.social?.instagramFollowing ? 'yes' : '',
    waOk: f.social?.whatsappSaved ? 'yes' : '',
    blocked: f.blocked ? 'yes' : '',
  })));

  addSheet(book, 'Nannies', [
    { header: 'ID', key: 'id', width: 26 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Nickname', key: 'nickname', width: 16 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'Age', key: 'age', width: 6 },
    { header: 'Experience (yrs)', key: 'exp', width: 15 },
    { header: 'Rate/hr', key: 'rate', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Rating', key: 'rating', width: 8 },
    { header: 'CPR', key: 'cpr', width: 6 },
    { header: 'Videos', key: 'videos', width: 8 },
    { header: 'Photos', key: 'photos', width: 8 },
    { header: 'Approved media', key: 'approved', width: 15 },
    { header: 'On profile', key: 'featured', width: 11 },
    { header: 'Last active', key: 'lastSeen', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], nannies.map((n) => ({
    id: str(n._id),
    name: n.fullName,
    nickname: n.nickname,
    phone: n.phone,
    email: n.email,
    status: n.nannyStatus,
    age: n.age,
    exp: n.experienceYears,
    rate: n.hourlyRate,
    rating: n.ratingAverage,
    cpr: n.cprCertified ? 'yes' : '',
    videos: (n.videos || []).length,
    photos: (n.photos || []).length,
    approved: [...(n.videos || []), ...(n.photos || [])].filter((m) => m.approved).length,
    featured: [...(n.videos || []), ...(n.photos || [])].filter((m) => m.approved && m.featured).length,
    lastSeen: day(n.lastSeenAt),
  })));

  addSheet(book, 'Bookings', [
    { header: 'Booking #', key: 'no', width: 14 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Family', key: 'family', width: 22 },
    { header: 'Family phone', key: 'famPhone', width: 18 },
    { header: 'Nanny', key: 'nanny', width: 22 },
    { header: 'Nanny phone', key: 'nannyPhone', width: 18 },
    { header: 'Start', key: 'start', width: 12 },
    { header: 'End', key: 'end', width: 12 },
    { header: 'Time', key: 'time', width: 8 },
    { header: 'Hours/day', key: 'hours', width: 10 },
    { header: 'Days', key: 'days', width: 7 },
    { header: 'Rate/hr', key: 'rate', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Paid', key: 'paid', width: 10 },
    { header: 'Emergency', key: 'emg', width: 11 },
    { header: 'Surcharge', key: 'surcharge', width: 11, style: { numFmt: '#,##0' } },
    { header: '24h live-in', key: 'liveIn', width: 11 },
    { header: 'Nannies needed', key: 'needed', width: 14 },
    { header: 'Children', key: 'children', width: 9 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], bookings.map((b) => ({
    no: b.bookingNumber,
    status: b.status,
    family: b.family?.fullName,
    famPhone: b.family?.phone,
    nanny: b.nanny?.nickname || b.nanny?.fullName,
    nannyPhone: b.nanny?.phone,
    start: b.startDate,
    end: b.endDate,
    time: b.startTime,
    hours: b.hoursPerDay,
    days: (b.serviceDays || []).length,
    rate: b.hourlyRate,
    total: b.totalAmount,
    paid: b.paymentStatus,
    emg: b.isEmergency ? 'yes' : '',
    surcharge: b.emergencySurcharge || 0,
    liveIn: b.isLiveIn ? 'yes' : '',
    needed: b.nanniesNeeded || 1,
    children: (b.children || []).length,
    address: b.address?.addressLine,
    created: day(b.createdAt),
  })));

  addSheet(book, 'Payments', [
    { header: 'Reference', key: 'ref', width: 18 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Booking', key: 'booking', width: 26 },
    { header: 'Amount', key: 'amount', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], payments.map((p) => ({
    ref: p.reference,
    kind: p.kind,
    booking: str(p.booking),
    amount: p.amount,
    status: p.status,
    method: p.method,
    created: day(p.createdAt),
  })));

  addSheet(book, 'Notes', [
    { header: 'About', key: 'targetType', width: 10 },
    { header: 'Target ID', key: 'target', width: 26 },
    { header: 'Booking #', key: 'booking', width: 12 },
    { header: 'Note', key: 'body', width: 60 },
    { header: 'Author', key: 'author', width: 20 },
    { header: 'Written', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], notes.map((n) => ({
    targetType: n.targetType,
    target: str(n.target),
    booking: n.bookingNumber || '',
    body: n.body,
    author: n.authorName,
    created: day(n.createdAt),
  })));

  addSheet(book, 'Callbacks', [
    { header: 'Reference', key: 'ref', width: 14 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Reason', key: 'reason', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Promised at', key: 'promised', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], callbacks.map((c) => ({
    ref: c.reference,
    name: c.fullName,
    phone: c.phone,
    reason: c.reason,
    status: c.status,
    promised: day(c.promisedCallAt),
    created: day(c.createdAt),
  })));

  addSheet(book, 'Tickets', [
    { header: 'Reference', key: 'ref', width: 14 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Priority', key: 'priority', width: 10 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
  ], tickets.map((t) => ({
    ref: t.reference || str(t._id),
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    created: day(t.createdAt),
  })));

  return book;
}

/* ------------------------------------------------------------------ *
 * The real database dump
 * ------------------------------------------------------------------ */

/**
 * Every collection, every field, in a form that can be loaded back.
 *
 * The spreadsheet above is for a person to read; it is not a backup anyone
 * could restore from — it drops most fields, every nested record (service
 * days, payouts' proofs, chat messages, sessions) and every collection it was
 * not written for. If the database were lost, the business would have been
 * rebuilt by hand from a summary. This is the whole database: one JSON line
 * per document in Extended JSON (so ObjectIds and dates come back as
 * themselves), gzipped, and encrypted with BACKUP_PASSWORD when it is set.
 *
 * Restore with: node scripts/restore-backup.mjs <file> --uri <mongo> --confirm <db>
 *
 * Line shapes:
 *   {"type":"meta", ...}                 first line: when, which database, versions
 *   {"type":"doc","c":"<collection>","d":<EJSON document>}
 *   {"type":"media","manifest":{...}}    last line: every archived media file we know of
 */

/** Every object in a bucket, for the manifest. Capped so a huge bucket cannot stall the job. */
async function listBucket({ bucket, endpoint, accessKeyId, secretAccessKey, region, prefix = '' }, cap = 200_000) {
  if (!(bucket && endpoint && accessKeyId && secretAccessKey)) return null;
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: region || 'auto', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey },
  });
  const objects = [];
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token,
    }));
    for (const o of out.Contents || []) objects.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token && objects.length < cap);
  return { bucket, prefix, count: objects.length, truncated: Boolean(token), objects };
}

/** Files in one local folder (not recursive: the archive is flat). */
async function listDir(dir) {
  try {
    const names = await fs.promises.readdir(dir);
    const files = [];
    for (const name of names) {
      if (name.endsWith('.part')) continue;
      // eslint-disable-next-line no-await-in-loop
      const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (st?.isFile()) files.push({ name, size: st.size, modified: st.mtime });
    }
    return { dir, count: files.length, files };
  } catch {
    return { dir, count: 0, files: [], missing: true };
  }
}

/**
 * What media exists and where, so a restore knows what the URLs in the
 * database should point at — and a missing file can be noticed rather than
 * discovered by a family looking at a broken photo.
 */
export async function buildMediaManifest() {
  const m = config.media;
  const safe = (p) => p.catch((err) => ({ error: err.message }));
  const [publicLocal, privateLocal, legacyPrivate, publicBucket, privateBucket] = await Promise.all([
    listDir(m.dir),
    listDir(m.privateDir),
    listDir(path.join(m.dir, 'private')),
    safe(listBucket(m.s3 || {})),
    safe(listBucket(m.privateS3 || {})),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    publicLocal,
    privateLocal,
    legacyPrivate,
    publicBucket,
    privateBucket,
  };
}

/** Keep the newest `keep` dumps in the folder and delete the rest. */
async function pruneDumps(dir, keep) {
  const names = (await fs.promises.readdir(dir).catch(() => []))
    .filter((n) => /^nip-db-.*\.jsonl\.gz(\.enc)?$/.test(n))
    .sort();
  const stale = names.slice(0, Math.max(0, names.length - keep));
  await Promise.all(stale.map((n) => fs.promises.unlink(path.join(dir, n)).catch(() => {})));
}

/**
 * Write the dump to BACKUP_DIR, and copy it to the private bucket if there is one.
 *
 * Streamed collection by collection, so a large database is never held in
 * memory whole. Returns where it went and how much is in it.
 */
export async function writeDatabaseDump({
  dir = config.backup.dir,
  password = config.backup.password,
  db = mongoose.connection.db,
} = {}) {
  if (!db) throw new Error('database is not connected');
  const { EJSON } = mongoose.mongo.BSON;

  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const encrypted = Boolean(password);
  const filename = `nip-db-${stamp}.jsonl.gz${encrypted ? '.enc' : ''}`;
  const dest = path.join(dir, filename);

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const counts = {};
  const manifest = await buildMediaManifest().catch((err) => ({ error: err.message }));

  async function* lines() {
    yield `${JSON.stringify({
      type: 'meta',
      format: 'nip-db-dump/1',
      createdAt: new Date().toISOString(),
      database: db.databaseName,
      collections,
    })}\n`;
    for (const name of collections) {
      counts[name] = 0;
      const cursor = db.collection(name).find({}, { batchSize: 500 });
      for await (const doc of cursor) {
        counts[name] += 1;
        yield `${JSON.stringify({ type: 'doc', c: name, d: EJSON.serialize(doc, { relaxed: false }) })}\n`;
      }
    }
    yield `${JSON.stringify({ type: 'media', manifest })}\n`;
  }

  const tmp = `${dest}.part`;
  const stages = [Readable.from(lines()), zlib.createGzip({ level: 6 })];
  if (encrypted) stages.push(encryptStream(password));
  stages.push(fs.createWriteStream(tmp));
  await pipeline(...stages);
  await fs.promises.rename(tmp, dest);

  const { size } = await fs.promises.stat(dest);
  const documents = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!documents) throw new Error('database dump contains no documents — refusing to call this a backup');

  // A copy off this machine, when there is somewhere private to put it. The
  // local disk on most hosts is wiped on deploy, so the local file alone is
  // only good until the next release.
  let uploaded = null;
  const privateStore = (await import('./privateStore.js')).default;
  if (privateStore.isConfigured()) {
    try {
      uploaded = await privateStore.putRaw(`backups/${filename}`, await fs.promises.readFile(dest),
        encrypted ? 'application/octet-stream' : 'application/gzip');
    } catch (err) {
      console.error(`[backup] could not upload the database dump to the private bucket: ${err.message}`);
    }
  } else {
    console.warn('[backup] no private bucket configured — the database dump exists only on this server\'s disk.');
  }

  await pruneDumps(dir, Math.max(1, config.backup.keep || 14));

  return {
    path: dest,
    filename,
    bytes: size,
    encrypted,
    collections: collections.length,
    documents,
    counts,
    uploaded,
    mediaFiles: {
      publicLocal: manifest?.publicLocal?.count ?? null,
      privateLocal: manifest?.privateLocal?.count ?? null,
      publicBucket: manifest?.publicBucket?.count ?? null,
      privateBucket: manifest?.privateBucket?.count ?? null,
    },
  };
}

/**
 * May customer data be emailed at all, and how?
 *
 * Production without BACKUP_PASSWORD is a refusal: the alternative is a file
 * of every family's phone and address sitting readable in inboxes for years.
 * Locally there is nothing real to protect, so it still sends (with a warning)
 * and development does not need a password configured to work.
 */
function emailPolicy() {
  const password = config.backup.password;
  if (password) return { encrypt: true, password };
  if (config.env === 'production') {
    return {
      refuse: 'BACKUP_PASSWORD is not set, so the backup was NOT emailed — it would have sent every '
        + "customer's details unencrypted. Set BACKUP_PASSWORD and send it again.",
    };
  }
  console.warn('[backup] BACKUP_PASSWORD is not set — emailing the backup UNENCRYPTED (allowed outside production only).');
  return { encrypt: false };
}

/** Largest dump we will attach to an email; bigger ones are only stored. */
const MAX_DUMP_ATTACHMENT = 15 * 1024 * 1024;

/**
 * Build today's workbook and database dump, store the dump, and email them.
 *
 * Returns what was sent so the scheduler can log it, and throws on failure so
 * a silent backup gap is impossible — a backup nobody knows has stopped is
 * worse than no backup at all.
 */
export async function sendDailyBackup({ to } = {}) {
  /**
   * The full dump first, and whatever happens to the email.
   *
   * A backup that only exists if the mail provider is up is not a backup. The
   * dump is written to disk (and the private bucket) before anything is sent;
   * if it fails the email still goes, and says so loudly.
   */
  let dump = null;
  let dumpError = null;
  try {
    dump = await writeDatabaseDump();
  } catch (err) {
    dumpError = err.message;
    console.error(`[backup] DATABASE DUMP FAILED: ${err.message}`);
  }

  /**
   * Everyone the office has listed, not one hardcoded address.
   *
   * The single address was one person's personal email. If they left, changed
   * it, or their inbox filled, every backup stopped arriving and nothing said
   * so — the one failure a backup cannot afford. `backupRecipients()` falls
   * back to BACKUP_EMAIL when the list is empty; with neither set there is
   * nobody to send to, which is reported as a failure rather than skipped.
   */
  const { backupRecipients } = await import('./settings.js');
  const recipients = to
    ? [to].flat().filter(Boolean)
    : await backupRecipients();

  if (!recipients.length) {
    throw new Error(`no backup recipients configured — nobody would receive it${dump ? ` (the database dump was saved to ${dump.path})` : ''}`);
  }

  const policy = emailPolicy();
  if (policy.refuse) {
    console.error(`[backup] REFUSED TO EMAIL: ${policy.refuse}`);
    throw new Error(`${policy.refuse}${dump ? ` The database dump was still saved to ${dump.path}.` : ''}`);
  }

  const book = await buildBackupWorkbook();
  const buffer = Buffer.from(await book.xlsx.writeBuffer());

  const stamp = new Date().toISOString().slice(0, 10);
  const sheetName = `nanny-in-paradise-backup-${stamp}.xlsx`;

  const rowsPerSheet = book.worksheets.map((s) => ({
    name: s.name,
    rows: Math.max(0, s.rowCount - 1),
  }));

  const counts = rowsPerSheet.map((s) => `${s.name}: ${s.rows}`).join(' · ');

  /**
   * Check the file before calling it a backup.
   *
   * The counts above were computed and then never compared against anything, so
   * a night where a query came back empty — a bad reconnect, a dropped
   * collection — produced a valid, empty workbook, emailed it, and logged
   * "Families: 0 · Nannies: 0" as a success. The failure alert only fires on a
   * thrown error, so it never fired for the one failure mode that matters: the
   * backup that looks fine and contains nothing.
   *
   * A business with bookings on the books cannot have an empty sheet for all of
   * them, so that is the floor. Throwing here is deliberate — the caller turns a
   * throw into an email and a loud log, which is exactly the handling this
   * needs.
   */
  const totalRows = rowsPerSheet.reduce((sum, s) => sum + s.rows, 0);
  if (!buffer.length) {
    throw new Error('backup produced an empty file');
  }
  if (buffer.length < 2000) {
    throw new Error(`backup file is only ${buffer.length} bytes — too small to be real`);
  }
  if (totalRows === 0) {
    throw new Error(`backup contains no rows at all (${counts}) — refusing to call this a backup`);
  }

  const attachments = [policy.encrypt
    ? { filename: `${sheetName}.enc`, content: encryptBuffer(buffer, policy.password) }
    : { filename: sheetName, content: buffer }];

  // The dump goes along when it is small enough for a mail provider, so the
  // inbox copy is a complete backup on its own. Larger ones stay in storage.
  let dumpNote;
  if (dump && dump.bytes <= MAX_DUMP_ATTACHMENT && dump.encrypted === policy.encrypt) {
    attachments.push({ filename: dump.filename, content: await fs.promises.readFile(dump.path) });
    dumpNote = `Database dump attached (${dump.filename}, ${dump.documents} documents in ${dump.collections} collections).`;
  } else if (dump) {
    dumpNote = `Database dump saved as ${dump.filename} (${Math.round(dump.bytes / 1e6)}MB, ${dump.documents} documents)`
      + `${dump.uploaded ? ' and copied to the private bucket' : ' on the server disk only'}; too large to attach.`;
  } else {
    dumpNote = `⚠️ The full database dump FAILED tonight: ${dumpError}. Only the spreadsheet below exists.`;
  }
  const mediaNote = dump?.mediaFiles
    ? `Media files — public disk: ${dump.mediaFiles.publicLocal ?? '?'}, private disk: ${dump.mediaFiles.privateLocal ?? '?'}, `
      + `public bucket: ${dump.mediaFiles.publicBucket ?? 'n/a'}, private bucket: ${dump.mediaFiles.privateBucket ?? 'n/a'} (full list inside the dump).`
    : '';
  const howToOpen = policy.encrypt
    ? 'The attachments are encrypted. To open them: node scripts/decrypt-backup.mjs <file> (it asks for BACKUP_PASSWORD).'
    : '';

  const bodyLines = [dumpNote, mediaNote, howToOpen].filter(Boolean);

  /**
   * One email each, rather than one email to everybody.
   *
   * A single send with several recipients fails as a unit: one address the
   * provider rejects — a typo, a closed mailbox — and nobody gets the backup.
   * Sent one at a time, a bad address costs only its own copy, and the others
   * still have the file.
   */
  const delivered = [];
  const failed = [];

  for (const recipient of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await send({
        to: recipient,
        subject: `Daily backup — ${stamp}${dump ? '' : ' (DATABASE DUMP FAILED)'}`,
        text: `Attached is the end-of-day backup for ${stamp}.\n\n${counts}\n\n${bodyLines.join('\n')}`,
        html: brandedEmail(`
          <p style="color:#333;font-size:15px;margin:0 0 8px">Attached is the end-of-day backup for <strong>${stamp}</strong>.</p>
          <p style="color:#666;font-size:13px;margin:0 0 8px">${counts.replace(/ · /g, '<br>')}</p>
          ${bodyLines.map((l) => `<p style="color:#666;font-size:13px;margin:0 0 6px">${escapeHtml(l)}</p>`).join('')}
        `),
        attachments,
      });
      delivered.push(recipient);
    } catch (err) {
      failed.push({ to: recipient, error: err.message });
      console.error(`[backup] could not send to ${recipient}: ${err.message}`);
    }
  }

  // Nobody received it. Thrown rather than returned, because the caller turns
  // a throw into the alert email that says the backup did not happen.
  if (!delivered.length) {
    throw new Error(
      `backup reached nobody (${failed.map((f) => `${f.to}: ${f.error}`).join('; ')})`,
    );
  }

  return {
    to: delivered,
    failed,
    filename: attachments[0].filename,
    encrypted: policy.encrypt,
    bytes: attachments[0].content.length,
    counts,
    rows: totalRows,
    sheets: rowsPerSheet,
    dump: dump ? {
      filename: dump.filename, bytes: dump.bytes, documents: dump.documents, uploaded: Boolean(dump.uploaded),
    } : null,
    dumpError,
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * A record of one order, emailed the moment it is paid for.
 *
 * The nightly file is a safety net for the whole business; this is a receipt
 * for a single transaction, and it lands while the order is still fresh. Two
 * different jobs, so two different emails: if the nightly one ever fails, the
 * per-order trail still reconstructs every booking that was actually paid.
 *
 * Same rules as the nightly file: it goes to the backup recipients (there is
 * no built-in personal address any more), the family's phone and address are
 * only ever inside the encrypted attachment, and in production nothing is sent
 * without BACKUP_PASSWORD.
 *
 * Failure is logged, never thrown — a bookkeeping email must not be able to
 * fail a payment that has already been approved.
 */
export async function sendOrderBackup(booking, { to } = {}) {
  if (!booking) return null;

  let recipients = to ? [to].flat().filter(Boolean) : [];
  if (!recipients.length) {
    const { backupRecipients } = await import('./settings.js');
    recipients = await backupRecipients().catch(() => []);
  }
  if (!recipients.length) {
    console.warn(`[backup] order receipt for #${booking.bookingNumber} not sent — no backup recipients configured`);
    return null;
  }

  const policy = emailPolicy();
  if (policy.refuse) {
    console.error(`[backup] order receipt for #${booking.bookingNumber} NOT emailed: ${policy.refuse}`);
    return null;
  }

  const { User } = await import('../models/index.js');
  const [family, nanny] = await Promise.all([
    booking.family ? User.findById(booking.family).select('fullName phone email').lean() : null,
    booking.nanny ? User.findById(booking.nanny).select('fullName nickname phone').lean() : null,
  ]);

  const rows = [
    ['Booking', booking.bookingNumber],
    ['Status', booking.status],
    ['Family', family?.fullName || '—'],
    ['Family phone', family?.phone || '—'],
    ['Nanny', nanny?.nickname || nanny?.fullName || '—'],
    ['Nanny phone', nanny?.phone || '—'],
    ['Dates', booking.isMultiDay ? `${booking.startDate} to ${booking.endDate}` : booking.startDate],
    ['Start time', booking.startTime || '—'],
    ['Hours per day', String(booking.hoursPerDay ?? '—')],
    ['Days booked', String((booking.serviceDays || []).length)],
    ['Children', String((booking.children || []).length)],
    ['Rate per hour', money(booking.hourlyRate || 0)],
    ['Total', money(booking.totalAmount || 0)],
    ['Paid', money(booking.paidAmount || 0)],
    ['Emergency', booking.isEmergency ? `yes (+${money(booking.emergencySurcharge || 0)} cash on arrival)` : 'no'],
    ['Address', booking.address?.addressLine || '—'],
  ];

  // A spreadsheet as well as the table, so these can be collected into a
  // ledger without retyping anything.
  const book = new ExcelJS.Workbook();
  book.creator = config.brand.name;
  addSheet(book, 'Order', [
    { header: 'Field', key: 'field', width: 22 },
    { header: 'Value', key: 'value', width: 50 },
  ], rows.map(([field, value]) => ({ field, value })));

  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  const filename = `order-${booking.bookingNumber}.xlsx`;

  // With encryption on, the email body carries nothing personal: the
  // family's name, phone and address are only in the encrypted file.
  const shown = policy.encrypt
    ? rows.filter(([k]) => ['Booking', 'Status', 'Dates', 'Days booked', 'Total', 'Paid'].includes(k))
    : rows;
  const attachment = policy.encrypt
    ? { filename: `${filename}.enc`, content: encryptBuffer(buffer, policy.password) }
    : { filename, content: buffer };

  for (const recipient of recipients) {
    // eslint-disable-next-line no-await-in-loop
    await send({
      to: recipient,
      subject: `Order paid — #${booking.bookingNumber} — ${money(booking.totalAmount || 0)}`,
      text: shown.map(([k, v]) => `${k}: ${v}`).join('\n'),
      html: brandedEmail(`
        <p style="color:#333;font-size:15px;margin:0 0 14px">
          Payment confirmed for booking <strong>#${booking.bookingNumber}</strong>.
        </p>
        <table style="border-collapse:collapse;font-size:14px">
          ${shown.map(([k, v]) => `
            <tr>
              <td style="padding:4px 14px 4px 0;color:#777;white-space:nowrap">${k}</td>
              <td style="padding:4px 0;color:#111"><strong>${escapeHtml(v)}</strong></td>
            </tr>`).join('')}
        </table>
      `),
      attachments: [attachment],
    });
  }

  return { to: recipients, filename: attachment.filename, bookingNumber: booking.bookingNumber };
}

export default {
  sendDailyBackup, buildBackupWorkbook, sendOrderBackup, writeDatabaseDump, buildMediaManifest,
};
