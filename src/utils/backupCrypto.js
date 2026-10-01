import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/**
 * Password encryption for backups (AES-256-GCM, key from scrypt).
 *
 * The nightly backup is a spreadsheet and a database dump with every family's
 * name, phone number and home address. It used to be emailed in the clear, so
 * it sat readable in every inbox, phone and mail-provider log it passed
 * through. Encrypted with BACKUP_PASSWORD, a leaked email is a useless file.
 *
 * File layout (all binary):
 *   "NIPBAK01" (8 bytes) | salt (16) | iv (12) | ciphertext | auth tag (16)
 *
 * The tag is at the end so a large dump can be encrypted as a stream. GCM
 * authenticates the whole file: a wrong password or a single flipped byte is
 * an error on decrypt, never silently wrong data.
 *
 * Decrypt with: node scripts/decrypt-backup.mjs <file.enc> [out]
 */

export const MAGIC = Buffer.from('NIPBAK01', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
// scrypt cost: deliberately slow to make guessing a weak password expensive.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(password, salt) {
  if (!password) throw new Error('a backup password is required');
  return crypto.scryptSync(String(password), salt, 32, SCRYPT);
}

/** Encrypt a buffer held in memory (the spreadsheet). */
export function encryptBuffer(buf, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]);
}

export function isEncrypted(buf) {
  return buf.length >= HEADER_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Decrypt a buffer produced by encryptBuffer or encryptStream. */
export function decryptBuffer(buf, password) {
  if (!isEncrypted(buf)) throw new Error('not an encrypted backup (missing NIPBAK01 header)');
  const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = buf.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('could not decrypt — wrong password, or the file is damaged');
  }
}

/** A transform that encrypts everything through it, writing header first and tag last. */
export function encryptStream(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  let started = false;
  return new Transform({
    transform(chunk, enc, cb) {
      if (!started) {
        this.push(Buffer.concat([MAGIC, salt, iv]));
        started = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!started) this.push(Buffer.concat([MAGIC, salt, iv]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

/**
 * Decrypt a file on disk to another file, streaming.
 *
 * The tag is read from the end first (GCM needs it before it will finish),
 * then the ciphertext between header and tag is streamed through. The output
 * is written to a temporary name and only renamed into place once the tag has
 * verified, so a failed decrypt never leaves a plausible-looking file behind.
 */
export async function decryptFile(inPath, outPath, password) {
  const { size } = await fs.promises.stat(inPath);
  if (size < HEADER_LEN + TAG_LEN) throw new Error('file too small to be an encrypted backup');
  const fh = await fs.promises.open(inPath, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    await fh.read(header, 0, HEADER_LEN, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted backup (missing NIPBAK01 header)');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);

  const tmp = `${outPath}.part`;
  try {
    await pipeline(
      fs.createReadStream(inPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      fs.createWriteStream(tmp),
    );
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw new Error(`could not decrypt — wrong password, or the file is damaged (${err.message})`);
  }
  await fs.promises.rename(tmp, outPath);
}

export default {
  encryptBuffer, decryptBuffer, encryptStream, decryptFile, isEncrypted, MAGIC,
};
