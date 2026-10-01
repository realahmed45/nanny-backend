/**
 * Restore a database dump made by the nightly backup.
 *
 *   cd server
 *   node scripts/restore-backup.mjs <nip-db-….jsonl.gz[.enc]> --uri <mongodb-uri> --confirm <database-name> [--drop]
 *
 * THIS WRITES TO A DATABASE. It is meant for loading a dump into a fresh or
 * scratch database (for example a new Atlas cluster after losing the old one,
 * or a local copy to inspect). Safety rails, all on purpose:
 *
 *   --uri       required. It never falls back to MONGODB_URI from .env, so it
 *               cannot hit the live database because a flag was forgotten.
 *   --confirm   required, and must equal the database name in --uri. Typing
 *               the name is the "yes, this one" step.
 *   --drop      without it, the restore refuses to touch any collection that
 *               already has documents. With it, each collection in the dump is
 *               emptied first and replaced by the dump's contents. Collections
 *               not in the dump are left alone.
 *   --dry-run   read and check the whole file, print what would be restored,
 *               write nothing.
 *
 * An encrypted dump (.enc) is decrypted on the fly: the password is
 * BACKUP_PASSWORD from the environment, or asked for on the terminal.
 *
 * Indexes are not in the dump; the app builds them itself on start-up
 * (Mongoose autoIndex), so start the server against the restored database
 * once afterwards. Media files are not in the dump either — the last line of
 * the dump is a manifest of every file that existed (disk and buckets), so
 * you can check which ones the restored records point at.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { decryptFile } from '../src/utils/backupCrypto.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !['--uri', '--confirm'].includes(args[i - 1]));
const uri = value('uri');
const confirm = value('confirm');
const drop = flag('drop');
const dryRun = flag('dry-run');

function usage(msg) {
  if (msg) console.error(`\n${msg}\n`);
  console.error('Usage: node scripts/restore-backup.mjs <dump-file> --uri <mongodb-uri> --confirm <database-name> [--drop] [--dry-run]');
  process.exit(2);
}

if (!file) usage('No dump file given.');
if (!fs.existsSync(file)) usage(`No such file: ${file}`);
if (!uri) usage('--uri is required (it never defaults to MONGODB_URI, on purpose).');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    // eslint-disable-next-line no-underscore-dangle
    rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(s); };
  });
}

// Decrypt first if needed, to a private temp file that is removed at the end.
let source = file;
let tempFile = null;
const head = Buffer.alloc(8);
{
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
}
if (head.toString('ascii') === 'NIPBAK01') {
  if (!process.env.BACKUP_PASSWORD) {
    try { (await import('dotenv')).config(); } catch { /* optional */ }
  }
  const password = process.env.BACKUP_PASSWORD || await askHidden('Backup password: ');
  tempFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nip-restore-')), 'dump.jsonl.gz');
  try {
    await decryptFile(file, tempFile, password);
  } catch (err) {
    fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
    console.error(err.message);
    process.exit(1);
  }
  source = tempFile;
}

const cleanup = () => {
  if (tempFile) fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
};

async function* records() {
  const rl = readline.createInterface({
    input: fs.createReadStream(source).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line);
  }
}

try {
  const { EJSON } = mongoose.mongo.BSON;

  // Pass 1: read the whole file, so a truncated or corrupt dump is found
  // before a single document has been written.
  let meta = null;
  const counts = {};
  let media = null;
  for await (const r of records()) {
    if (r.type === 'meta') meta = r;
    else if (r.type === 'doc') counts[r.c] = (counts[r.c] || 0) + 1;
    else if (r.type === 'media') media = r.manifest;
  }
  if (!meta || meta.format !== 'nip-db-dump/1') throw new Error('this does not look like a nightly database dump (no meta line)');
  if (!media) console.warn('WARNING: no media manifest at the end of the dump — it may be truncated.');

  console.log(`Dump of "${meta.database}" taken ${meta.createdAt}`);
  for (const [c, n] of Object.entries(counts)) console.log(`  ${c.padEnd(28)} ${n}`);
  console.log(`  ${'TOTAL'.padEnd(28)} ${Object.values(counts).reduce((a, b) => a + b, 0)}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    cleanup();
    process.exit(0);
  }

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15_000 }).asPromise();
  const db = conn.db;
  const target = db.databaseName;
  if (!confirm || confirm !== target) {
    await conn.close();
    cleanup();
    usage(`Refusing to write. The target database is "${target}"; pass --confirm ${target} to restore into it.`);
  }

  console.log(`\n!!! Restoring into database "${target}"${drop ? ' — collections in the dump will be EMPTIED first' : ''} !!!`);
  for (let s = 5; s > 0; s -= 1) {
    process.stdout.write(`  starting in ${s}… (Ctrl+C to abort)\r`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write('\n');

  // Refuse to merge into live data unless --drop was given.
  for (const c of Object.keys(counts)) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await db.collection(c).estimatedDocumentCount();
    if (existing && !drop) {
      await conn.close();
      throw new Error(`collection "${c}" already has ${existing} documents in "${target}". Use --drop to replace it, or restore into an empty database.`);
    }
  }
  if (drop) {
    for (const c of Object.keys(counts)) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection(c).deleteMany({});
    }
  }

  // Pass 2: write, in batches.
  const batches = {};
  let written = 0;
  const flush = async (c) => {
    const docs = batches[c];
    if (!docs?.length) return;
    batches[c] = [];
    await db.collection(c).insertMany(docs, { ordered: false });
    written += docs.length;
    process.stdout.write(`  ${written} documents written\r`);
  };
  for await (const r of records()) {
    if (r.type !== 'doc') continue;
    (batches[r.c] ||= []).push(EJSON.deserialize(r.d, { relaxed: false }));
    if (batches[r.c].length >= 500) await flush(r.c);
  }
  for (const c of Object.keys(batches)) {
    // eslint-disable-next-line no-await-in-loop
    await flush(c);
  }
  process.stdout.write('\n');
  await conn.close();

  console.log(`Done: ${written} documents restored into "${target}".`);
  console.log('Next: start the server against this database once so it builds its indexes,');
  console.log('and check the media manifest (last line of the dump) against your storage.');
} catch (err) {
  console.error(`\nRestore failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
